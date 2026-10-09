/**
 * "Review changes" (#255): run an edit request without applying it, and show
 * exactly what it would send to the device.
 *
 * The pure half: deciding which RouterOS commands only read, which requests
 * can be previewed, and how a recorded write is described. The request
 * plumbing lives in utils/previewContext.ts and services/changePreview.ts.
 */
import { isSecretKey } from './redactSecrets';

/** One write the request would have sent, as the review modal shows it. */
export interface PreviewStep {
  /** add, set, remove, move, enable, disable, or the command's own verb. */
  action: string;
  /** Menu path, e.g. /interface/vlan. */
  path: string;
  /** The device the write was for (its API address). */
  host: string;
  /** Parameters as sent, secrets hidden. */
  params: Record<string, string>;
  /** The item a set/remove/move acts on, as it is now (null when unknown). */
  target: Record<string, string> | null;
  /** For set: each parameter that changes, with its current value. */
  changes: { field: string; from: string | null; to: string }[];
  /** For set: parameters sent that already have that value. */
  unchanged: string[];
  /** The same write as a terminal command. */
  cli: string;
}

/** Verbs that only read. Anything else is recorded instead of sent. */
const READ_VERBS = new Set(['print', 'getall', 'get', 'monitor', 'monitor-traffic']);

/** True when a RouterOS API command only reads, so a preview may run it. */
export function isReadCommand(command: string, params: Record<string, string> = {}): boolean {
  const verb = command.split('/').filter(Boolean).pop() ?? '';
  if (READ_VERBS.has(verb)) return true;
  // /export prints the configuration; with file= it writes one.
  if (verb === 'export') return !('file' in params);
  return false;
}

export function splitCommand(command: string): { path: string; verb: string } {
  const parts = command.split('/').filter(Boolean);
  const verb = parts.pop() ?? '';
  return { path: '/' + parts.join('/'), verb };
}

/** Parameter names that identify the item rather than set a value. */
const ID_KEYS = new Set(['.id', 'numbers']);

const HIDDEN = '(hidden)';

/** Parameters with secrets replaced; the review modal never shows a key or passphrase. */
export function hideSecrets(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = isSecretKey(k) && v !== '' ? HIDDEN : v;
  return out;
}

/** A value quoted the way the RouterOS terminal needs it. */
export function cliValue(v: string): string {
  if (v !== '' && /^[A-Za-z0-9._:/*,+@-]+$/.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$') + '"';
}

/**
 * How a set/remove names its item: by name where the menu has names, else by
 * its internal id, which the terminal accepts too. Never by comment or
 * address: those aren't unique ("defconf" marks dozens of items), so a copied
 * command could act on more than was reviewed.
 */
function cliSelector(id: string | undefined, target: Record<string, string> | null): string {
  if (target?.name) return `[find name=${cliValue(target.name)}]`;
  if (target?.['.id']) return target['.id'];
  return id ? cliValue(id) : '';
}

/** The write as a terminal command, with secrets hidden. */
export function toCli(command: string, params: Record<string, string>, target: Record<string, string> | null): string {
  const { path, verb } = splitCommand(command);
  const shown = hideSecrets(params);
  const id = params['.id'] ?? params.numbers;
  const words = [path.split('/').filter(Boolean).join(' '), verb];
  const selector = id !== undefined ? cliSelector(id, target) : '';
  if (selector) words.push(selector);
  for (const [k, v] of Object.entries(shown)) {
    if (ID_KEYS.has(k)) continue;
    // An empty value clears the setting; the terminal needs it quoted.
    words.push(`${k}=${v === HIDDEN ? HIDDEN : cliValue(v)}`);
  }
  return '/' + words.join(' ');
}

/** RouterOS reports booleans as true/false but accepts yes/no; compare them as one. */
function sameValue(current: string | undefined, next: string): boolean {
  if (current === undefined) return false;
  const norm = (s: string) => (s === 'yes' ? 'true' : s === 'no' ? 'false' : s);
  return norm(current) === norm(next);
}

/**
 * Parameters as the client puts them on the wire: `=${key}=${value}`, so an
 * array a route passes (DNS servers) goes out comma-joined.
 */
export function wireParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = String(v);
  return out;
}

/** Counters and live state: they describe the moment, not the configuration. */
const LIVE_FIELD = /(byte|packet|drop|-time$|^running$|^actual-|^current-|^managed$|^cache-used$|^slave$|^dynamic$|^invalid$|^inactive$|^link-downs$|^fp-|^last-|^uptime$)/;

/** The item as the review shows it: its configuration, without counters. */
export function trimTarget(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) if (!LIVE_FIELD.test(k)) out[k] = v;
  return out;
}

/** Describe one recorded write, given the item it acts on as it is now. */
export function describeWrite(
  host: string,
  command: string,
  rawParams: Record<string, unknown>,
  rawTarget: Record<string, string> | null
): PreviewStep {
  const { path, verb } = splitCommand(command);
  const params = wireParams(rawParams);
  const target = rawTarget ? trimTarget(rawTarget) : null;
  const changes: PreviewStep['changes'] = [];
  const unchanged: string[] = [];
  if (verb === 'set') {
    for (const [k, v] of Object.entries(params)) {
      if (ID_KEYS.has(k)) continue;
      const secret = isSecretKey(k);
      if (target && sameValue(target[k], v)) { unchanged.push(k); continue; }
      changes.push({
        field: k,
        from: target && k in target ? (secret ? HIDDEN : target[k]) : null,
        to: secret && v !== '' ? HIDDEN : v,
      });
    }
  }
  return {
    action: verb,
    path,
    host,
    params: hideSecrets(params),
    target: target ? hideSecrets(target) : null,
    changes,
    unchanged,
    cli: toCli(command, params, target),
  };
}

/**
 * The query that reads the item a write acts on, or null when it names none.
 * A singleton menu (/ip/dns/set) has no id: its only row is the target.
 */
export function targetQuery(command: string, params: Record<string, string>): { print: string; queries: string[] } | null {
  const { path, verb } = splitCommand(command);
  const id = params['.id'] ?? params.numbers;
  if (id !== undefined && id !== '') {
    // Several ids, or a name list, can't be read back as one row.
    if (id.includes(',')) return null;
    return { print: `${path}/print`, queries: [id.startsWith('*') ? `?.id=${id}` : `?name=${id}`] };
  }
  if (verb === 'set') return { print: `${path}/print`, queries: [] };
  return null;
}

/**
 * Edit requests that can be previewed. Explicit on purpose: a request is only
 * previewable when everything it changes goes through the RouterOS API, which
 * is what the preview intercepts. Anything else is refused, not half-previewed.
 */
const PREVIEWABLE: [string, RegExp][] = [
  // Device tabs
  ['PUT', /^\/api\/devices\/\d+\/interfaces\/[^/]+$/],
  ['PUT', /^\/api\/devices\/\d+\/ports\/[^/]+\/vlan$/],
  ['POST|PUT|DELETE', /^\/api\/devices\/\d+\/(firewall|nat)(\/[^/]+)?$/],
  ['POST|PUT|DELETE', /^\/api\/devices\/\d+\/(address-lists|queues)(\/[^/]+)?$/],
  ['PUT', /^\/api\/devices\/\d+\/services\/[^/]+$/],
  ['PUT', /^\/api\/devices\/\d+\/(system-config|clock|l3hw)$/],
  ['POST|DELETE', /^\/api\/devices\/\d+\/ip-addresses(\/[^/]+)?$/],
  ['POST|PUT|DELETE', /^\/api\/devices\/\d+\/routing(\/(ospf\/instance|ospf\/area|bgp\/connection|tables|filters\/rule))?(\/[^/]+)?$/],
  ['POST|PUT|DELETE', /^\/api\/devices\/\d+\/(vlans|bonds)(\/[^/]+)?$/],
  ['PUT', /^\/api\/devices\/\d+\/bridge\/[^/]+\/vlan-filtering$/],
  // Network services (device in ?deviceId=)
  ['POST|PUT|DELETE', /^\/api\/network-services\/dhcp\/(server|pool|static-lease)(\/[^/]+)?$/],
  ['PUT', /^\/api\/network-services\/(dns|ntp|netflow)$/],
  ['POST|PUT|DELETE', /^\/api\/network-services\/dns\/static(\/[^/]+)?$/],
  ['POST|PUT|DELETE', /^\/api\/network-services\/wireguard(\/peer)?(\/[^/]+)?$/],
  ['POST|PUT|DELETE', /^\/api\/network-services\/syslog\/(action|rule)(\/[^/]+)?$/],
  // Wireless
  ['POST|PUT|DELETE', /^\/api\/wireless\/\d+\/(interfaces|security-profiles)(\/[^/]+)?$/],
];

/** Paths under a previewable prefix that act rather than configure. */
const NOT_PREVIEWABLE = /\/(reset-counters|flush)$/;

export function isPreviewableRoute(method: string, url: string): boolean {
  const path = url.split('?')[0].replace(/\/+$/, '');
  if (NOT_PREVIEWABLE.test(path)) return false;
  return PREVIEWABLE.some(([methods, re]) => methods.split('|').includes(method.toUpperCase()) && re.test(path));
}

/**
 * True when a SQL statement could change data. A preview skips these, so an
 * edit route that also records its result locally leaves the database alone.
 */
export function isDbWrite(sql: string): boolean {
  const s = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  if (s.startsWith('SELECT') || s.startsWith('SHOW') || s.startsWith('EXPLAIN')) {
    // SELECT … FOR UPDATE takes a lock but changes nothing; still a read.
    return false;
  }
  if (s.startsWith('WITH')) return /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(s);
  return true;
}
