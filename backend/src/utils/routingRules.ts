/**
 * Routing rules (policy routing, #370): RouterOS 7's /routing/rule and
 * RouterOS 6's /ip/route/rule, read in order, with what's wrong with them.
 *
 * Rules are tried top to bottom and the first one that matches decides,
 * whatever its action, so a rule that an earlier one already covers never
 * applies. That, an identical copy of an earlier rule, a table that isn't
 * there, and a table with no active routes are what gets flagged.
 */
import { inPrefix } from './tunnels';

type Ros = Record<string, string>;

export interface RuleFlag { level: 'warn' | 'info'; text: string }

export interface RoutingRule {
  id: string;
  /** 1-based, in the device's order. */
  position: number;
  src: string | null;
  dst: string | null;
  routingMark: string | null;
  iface: string | null;
  action: string;
  table: string | null;
  minPrefix: string | null;
  disabled: boolean;
  invalid: boolean;
  dynamic: boolean;
  comment: string | null;
  flags: RuleFlag[];
}

export interface TableRoutes {
  table: string;
  routes: { dst: string; gateway: string | null; distance: string | null; active: boolean }[];
}

const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';
const val = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/** Rows from /routing/rule (7) or /ip/route/rule (6), in order. */
export function readRules(rows: Ros[]): RoutingRule[] {
  return rows.map((r, i) => ({
    id: r['.id'] ?? String(i),
    position: i + 1,
    src: val(r['src-address']),
    dst: val(r['dst-address']),
    routingMark: val(r['routing-mark']),
    iface: val(r['interface']),
    action: val(r['action']) ?? 'lookup',
    table: val(r['table']),
    minPrefix: val(r['min-prefix']),
    disabled: isTrue(r['disabled']),
    invalid: isTrue(r['invalid']),
    dynamic: isTrue(r['dynamic']),
    comment: val(r['comment']),
    flags: [],
  }));
}

/** A rule's routes, by table (RouterOS 7 `routing-table`, 6 `routing-mark`). */
export function routesByTable(routes: Ros[]): Map<string, TableRoutes> {
  const out = new Map<string, TableRoutes>();
  for (const r of routes) {
    const table = val(r['routing-table']) ?? val(r['routing-mark']) ?? 'main';
    if (!out.has(table)) out.set(table, { table, routes: [] });
    out.get(table)!.routes.push({
      dst: r['dst-address'] ?? '',
      gateway: val(r['gateway']) ?? val(r['immediate-gw']),
      distance: val(r['distance']),
      active: isTrue(r['active']) && !isTrue(r['disabled']),
    });
  }
  return out;
}

/** Whether prefix `outer` takes in every address of `inner` (both "a.b.c.d/n" or a bare address). */
export function prefixCovers(outer: string, inner: string): boolean {
  const len = (p: string) => Number(p.split('/')[1] ?? (p.includes(':') ? 128 : 32));
  if (outer.includes(':') !== inner.includes(':')) return false;
  return len(inner) >= len(outer) && inPrefix(inner.split('/')[0], outer);
}

/** `a` matches at least everything `b` does. */
function covers(a: RoutingRule, b: RoutingRule): boolean {
  const addr = (x: string | null, y: string | null) => x === null || (y !== null && prefixCovers(x, y));
  const same = (x: string | null, y: string | null) => x === null || x === y;
  return addr(a.src, b.src) && addr(a.dst, b.dst) && same(a.routingMark, b.routingMark) && same(a.iface, b.iface);
}

const sameMatch = (a: RoutingRule, b: RoutingRule) =>
  a.src === b.src && a.dst === b.dst && a.routingMark === b.routingMark && a.iface === b.iface && a.minPrefix === b.minPrefix;

/**
 * Flag each rule. `tables` are the device's routing tables (RouterOS 7), or
 * null where RouterOS has none to check against (6, where tables are marks).
 */
export function analyseRules(rules: RoutingRule[], tables: string[] | null, routes: Map<string, TableRoutes>): RoutingRule[] {
  const known = tables ? new Set(['main', ...tables]) : null;
  return rules.map((rule, i) => {
    const flags: RuleFlag[] = [];
    if (rule.invalid) flags.push({ level: 'warn', text: 'RouterOS marks this rule invalid.' });
    if (!rule.disabled) {
      // min-prefix lets a lookup be refused and the next rule tried, so a
      // rule with one is never treated as covering what comes after it.
      const earlier = rules.slice(0, i).filter((r) => !r.disabled && !r.invalid && !r.minPrefix);
      const twin = earlier.find((r) => sameMatch(r, rule) && r.action === rule.action && r.table === rule.table);
      const cover = twin ?? earlier.find((r) => covers(r, rule));
      if (twin) flags.push({ level: 'warn', text: `Same as rule ${twin.position}, so it never applies.` });
      else if (cover) flags.push({ level: 'warn', text: `Never applies: rule ${cover.position} matches everything this one does, and the first match wins.` });
    }
    const needsTable = rule.action === 'lookup' || rule.action === 'lookup-only-in-table';
    if (needsTable && rule.table) {
      if (known && !known.has(rule.table)) {
        flags.push({ level: 'warn', text: `Table ${rule.table} doesn't exist on this device.` });
      } else if (!(routes.get(rule.table)?.routes.some((r) => r.active))) {
        flags.push(rule.action === 'lookup-only-in-table'
          ? { level: 'warn', text: `Table ${rule.table} has no active routes, so matching traffic is unreachable.` }
          : { level: 'info', text: `Table ${rule.table} has no active routes.` });
      }
    }
    return { ...rule, flags };
  });
}

const ACTIONS = new Set(['lookup', 'lookup-only-in-table', 'drop', 'unreachable']);
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

function validPrefix(p: string): boolean {
  const [net, len] = p.split('/');
  if (net.includes(':')) {
    if (!/^[0-9a-f:]+$/i.test(net) || !inPrefix(net, net)) return false;
    return len === undefined || (/^\d+$/.test(len) && Number(len) <= 128);
  }
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(net) || net.split('.').some((o) => Number(o) > 255)) return false;
  return len === undefined || (/^\d+$/.test(len) && Number(len) <= 32);
}

export interface RuleInput extends Record<string, string | undefined> {
  'src-address'?: string; 'dst-address'?: string; 'routing-mark'?: string; interface?: string;
  action: string; table?: string; comment?: string;
}

/** A new rule from the form, or what's wrong with it, field by field. */
export function parseRuleInput(body: Record<string, unknown>): { rule: RuleInput } | { errors: Record<string, string> } {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const errors: Record<string, string> = {};
  const rule: RuleInput = { action: s('action') || 'lookup' };
  for (const k of ['src-address', 'dst-address'] as const) {
    const v = s(k);
    if (!v) continue;
    if (!validPrefix(v)) errors[k] = `${v} isn't an address or prefix (like 192.168.52.0/24).`;
    else rule[k] = v;
  }
  if (rule['src-address'] && rule['dst-address'] && rule['src-address'].includes(':') !== rule['dst-address'].includes(':')) {
    errors['dst-address'] = 'Source and destination must both be IPv4 or both IPv6.';
  }
  for (const k of ['routing-mark', 'interface'] as const) {
    const v = s(k);
    if (!v) continue;
    if (!NAME.test(v)) errors[k] = 'Letters, digits, dot, dash and underscore only.';
    else rule[k] = v;
  }
  if (!ACTIONS.has(rule.action)) errors.action = 'Choose an action.';
  const table = s('table');
  if (rule.action === 'lookup' || rule.action === 'lookup-only-in-table') {
    if (!table) errors.table = 'Choose the table to look up.';
    else if (!NAME.test(table)) errors.table = 'Letters, digits, dot, dash and underscore only.';
    else rule.table = table;
  }
  const comment = s('comment');
  if (comment.length > 200) errors.comment = 'Keep the comment under 200 characters.';
  else if (comment) rule.comment = comment;
  return Object.keys(errors).length ? { errors } : { rule };
}
