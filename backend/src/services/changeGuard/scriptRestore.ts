/**
 * Change Guard's script mode: a restore that puts back exactly what a change
 * touched, without a reboot.
 *
 * Script mode used to save a full `/export` and `/import` it on revert. But
 * `/import` only adds, and stops at the first error, and a full export starts
 * by adding things that already exist ("already have interface with name
 * bridge"), so the revert aborted on its first lines and restored nothing.
 * That went unnoticed from 0.18.0 until it was tested on hardware.
 *
 * Instead, the menus a change can touch are read before it is applied, and a
 * restore script is written from that snapshot. Rows are matched by RouterOS's
 * internal ids, which survive edits:
 *
 *   - a row that still exists is set back to its old values;
 *   - a row the change deleted is added again;
 *   - a row the change created (an id not in the snapshot) is removed;
 *   - an ordered menu (firewall filter, NAT) is rebuilt in its old order: the
 *     old rules are added after the current ones, and the current ones removed
 *     only if every add worked.
 *
 * Removals run first, children before parents (a bond's bridge port before the
 * bond), then sets and adds, parents first (a bridge before its ports). Every
 * command is wrapped so one failure doesn't stop the rest; a `set` that fails
 * as a whole is retried one property at a time, so a read-only property the
 * lists below missed costs only itself.
 *
 * A change whose kind has no scope here falls back to binary mode, so it is
 * still protected (with a reboot). Built for RouterOS 7; v6 falls back too.
 */

export type RosRow = Record<string, string>;

/**
 * keyed: set back by id, add back what's gone, remove what's new.
 * replace: like keyed, but each snapshot row is removed and added again rather
 *   than set back (an address-list entry given a timeout becomes dynamic, and
 *   can't be set back to static).
 * ordered: rebuilt whole, in order (firewall rules).
 * setOnly: rows that always exist (services, physical ports): set back only.
 */
type MenuMode = 'keyed' | 'replace' | 'ordered' | 'setOnly';

interface MenuDef {
  /** API path, e.g. /interface/bridge/port. */
  path: string;
  mode: MenuMode;
  /** Properties a minimal `add` needs, for the fallback when a full add fails. */
  addKeys?: string[];
  /** Only these properties are written back. Keeps status and counters out, and the script small. */
  only?: string[];
  /** For menus with too many properties to list (firewall matchers): never write these back. */
  readOnly?: string[];
  /**
   * Retry a failed set one property at a time, and a failed add with only
   * `addKeys`. For small menus whose properties depend on each other (a
   * bridge's admin-mac only applies with auto-mac off).
   */
  fallback?: boolean;
  /** The menu has a `dynamic` flag; dynamic rows are RouterOS's own and left alone. */
  hasDynamic?: boolean;
  /**
   * Properties RouterOS leaves out of `print` when unset, so a value the change
   * added would survive the restore. They are unset again when the snapshot
   * didn't have them. `comment` is handled for every menu that lists it.
   */
  unsetIfAbsent?: string[];
}

const GENERIC_READ_ONLY = ['.id', '.nextid', '.about', '.repeated', 'dynamic', 'invalid', 'running', 'inactive', 'slave', 'actual-mtu', 'managed'];

/** In dependency order: parents first. */
const MENUS = {
  bridge: {
    path: '/interface/bridge', mode: 'keyed', addKeys: ['name'], hasDynamic: true, fallback: true,
    only: ['name', 'mtu', 'arp', 'arp-timeout', 'protocol-mode', 'fast-forward', 'igmp-snooping', 'auto-mac',
      'admin-mac', 'ageing-time', 'priority', 'max-message-age', 'forward-delay', 'transmit-hold-count',
      'vlan-filtering', 'ether-type', 'pvid', 'frame-types', 'ingress-filtering', 'dhcp-snooping',
      'port-cost-mode', 'mvrp', 'disabled', 'comment'],
  },
  bonding: {
    path: '/interface/bonding', mode: 'keyed', addKeys: ['name', 'slaves'], fallback: true,
    only: ['name', 'slaves', 'mode', 'lacp-rate', 'transmit-hash-policy', 'mtu', 'min-links', 'link-monitoring',
      'mii-interval', 'arp-interval', 'arp-ip-targets', 'primary', 'up-delay', 'down-delay', 'lacp-user-key',
      'forced-mac-address', 'disabled', 'comment'],
  },
  interface: {
    path: '/interface', mode: 'setOnly', only: ['disabled', 'mtu', 'comment'],
  },
  ethernet: {
    path: '/interface/ethernet', mode: 'setOnly',
    only: ['name', 'mtu', 'l2mtu', 'arp', 'loop-protect', 'auto-negotiation', 'advertise', 'speed', 'full-duplex',
      'tx-flow-control', 'rx-flow-control', 'fec-mode', 'disabled', 'comment'],
  },
  ethernetPoe: {
    path: '/interface/ethernet/poe', mode: 'setOnly', only: ['poe-out', 'poe-priority', 'poe-voltage'],
  },
  bridgePort: {
    path: '/interface/bridge/port', mode: 'keyed', hasDynamic: true,
    only: ['interface', 'bridge', 'pvid', 'frame-types', 'ingress-filtering', 'tag-stacking', 'hw', 'edge',
      'point-to-point', 'horizon', 'disabled', 'comment'],
  },
  bridgeVlan: {
    path: '/interface/bridge/vlan', mode: 'keyed', hasDynamic: true,
    only: ['bridge', 'vlan-ids', 'tagged', 'untagged', 'disabled', 'comment'],
  },
  ipAddress: {
    path: '/ip/address', mode: 'keyed', hasDynamic: true,
    only: ['address', 'network', 'interface', 'disabled', 'comment'],
  },
  ipRoute: {
    path: '/ip/route', mode: 'keyed', addKeys: ['dst-address', 'gateway'], hasDynamic: true, fallback: true,
    only: ['dst-address', 'gateway', 'routing-table', 'distance', 'scope', 'target-scope', 'check-gateway',
      'pref-src', 'blackhole', 'vrf-interface', 'suppress-hw-offload', 'disabled', 'comment'],
    unsetIfAbsent: ['pref-src', 'check-gateway', 'vrf-interface'],
  },
  ipService: {
    path: '/ip/service', mode: 'setOnly', hasDynamic: true, fallback: true,
    only: ['port', 'address', 'available-from', 'vrf', 'max-sessions', 'certificate', 'tls-version', 'disabled'],
  },
  addressList: {
    path: '/ip/firewall/address-list', mode: 'replace', hasDynamic: true,
    only: ['list', 'address', 'timeout', 'disabled', 'comment'],
  },
  firewallFilter: {
    path: '/ip/firewall/filter', mode: 'ordered', hasDynamic: true, readOnly: ['bytes', 'packets'],
  },
  firewallNat: {
    path: '/ip/firewall/nat', mode: 'ordered', hasDynamic: true, readOnly: ['bytes', 'packets'],
  },
} satisfies Record<string, MenuDef>;

export type MenuKey = keyof typeof MENUS;
const ORDER = Object.keys(MENUS) as MenuKey[];

/** What each kind of guarded change can touch. A kind not listed falls back to binary mode. */
const SCOPES: Record<string, MenuKey[]> = {
  'bridge.vlan-filtering': ['bridge'],
  'port.vlan': ['bridgePort', 'bridgeVlan'],
  'vlan.add': ['bridgePort', 'bridgeVlan'],
  'vlan.update': ['bridgePort', 'bridgeVlan'],
  'vlan.delete': ['bridgePort', 'bridgeVlan'],
  'vlan.copy': ['bridgePort', 'bridgeVlan'],
  // A deleted bond or bridge leaves addresses pointing at its old id; setting
  // them back by name repairs that.
  'bond.create': ['bonding', 'bridgePort', 'bridgeVlan', 'ipAddress'],
  'bond.update': ['bonding', 'bridgePort', 'bridgeVlan', 'ipAddress'],
  'bond.delete': ['bonding', 'bridgePort', 'bridgeVlan', 'ipAddress'],
  'bridge-port.move': ['bridge', 'bridgePort', 'bridgeVlan', 'ipAddress'],
  'bridge.delete': ['bridge', 'bridgePort', 'bridgeVlan', 'ipAddress'],
  'bridge.add': ['bridge'],
  'bridge.set': ['bridge'],
  'interface.set': ['interface', 'ethernet', 'ethernetPoe'],
  'ip.add': ['ipAddress'],
  'ip.remove': ['ipAddress'],
  'ip.set': ['ipAddress'],
  'route.add': ['ipRoute'],
  'route.remove': ['ipRoute'],
  'service.toggle': ['ipService'],
  'service.allowed-from': ['ipService'],
  'firewall.add': ['firewallFilter'],
  'firewall.set': ['firewallFilter'],
  'firewall.move': ['firewallFilter'],
  'firewall.remove': ['firewallFilter'],
  'nat.add': ['firewallNat'],
  'nat.set': ['firewallNat'],
  'nat.move': ['firewallNat'],
  'nat.remove': ['firewallNat'],
  'address-list.add': ['addressList'],
  'address-list.set': ['addressList'],
  'address-list.remove': ['addressList'],
};

/** The menus to snapshot for a kind of change, parents first; null when script mode can't cover it. */
export function restoreScopeFor(kind: string): MenuKey[] | null {
  const scope = SCOPES[kind];
  return scope ? ORDER.filter((m) => scope.includes(m)) : null;
}

export function menuPath(key: MenuKey): string {
  return MENUS[key].path;
}

export interface CapturedMenu { menu: MenuKey; rows: RosRow[] }

/** The CLI form of an API path: /interface/bridge/port -> /interface bridge port. */
const cli = (path: string): string => '/' + path.slice(1).split('/').join(' ');

/** A RouterOS string literal. */
export function rosQuote(v: string): string {
  return '"' + v
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\?/g, '\\?')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

const ROS_ID = /^\*[0-9A-Fa-f]+$/;
const PROP_NAME = /^[a-z][a-z0-9-]*$/;

/** The properties of a row to write back, in the order RouterOS printed them. */
function settable(def: MenuDef, row: RosRow): [string, string][] {
  const ro = new Set([...GENERIC_READ_ONLY, ...(def.readOnly ?? [])]);
  return Object.entries(row)
    .filter(([k]) => PROP_NAME.test(k) && (def.only ? def.only.includes(k) : !ro.has(k)))
    // The API prints booleans as true/false; yes/no is what every RouterOS version accepts.
    .map(([k, v]) => [k, v === 'true' ? 'yes' : v === 'false' ? 'no' : v]);
}

const assign = (props: [string, string][]): string => props.map(([k, v]) => `${k}=${rosQuote(v)}`).join(' ');
const isStatic = (row: RosRow): boolean => row['dynamic'] !== 'true' && ROS_ID.test(row['.id'] ?? '');

/** RouterOS refuses a script or scheduler body of 64 KB; stay well under it. */
export const CHUNK_MAX = 48 * 1024;

export interface RestorePlan {
  /** The scheduler's on-event: runs the chunks in order, then removes them. */
  onEvent: string;
  /** `/system script` bodies, named `${schedulerName}-1`, `-2`, … */
  chunks: string[];
}

/**
 * The restore for a snapshot, in chunks small enough for RouterOS. The
 * scheduler removes itself before anything else, so a revert fires once at
 * most, and the chunks and any variables they used are removed at the end.
 */
export function buildRestorePlan(captured: CapturedMenu[], schedulerName: string): RestorePlan {
  const caps = ORDER.flatMap((m) => captured.filter((c) => c.menu === m));
  const tag = schedulerName.replace(/[^A-Za-z0-9]/g, '');
  const say = (level: 'info' | 'warning' | 'error', msg: string) => `:log ${level} ${rosQuote(`Change Guard: ${msg}`)}`;
  // Each group is self-contained, or uses globals, so it can go in any chunk.
  const groups: string[] = [];

  // Removals: rows the change created, children first.
  [...caps].reverse().forEach((cap) => {
    const def: MenuDef = MENUS[cap.menu];
    if (def.mode !== 'keyed' && def.mode !== 'replace') return;
    const c = cli(def.path);
    const ids = cap.rows.filter(isStatic).map((r) => rosQuote(r['.id']));
    const all = def.hasDynamic ? `[${c} find where dynamic=no]` : `[${c} find]`;
    groups.push(`:local keep ${ids.length ? `{${ids.join(';')}}` : '[:toarray ""]'}\n`
      + `:foreach i in=${all} do={ :if ([:typeof [:find $keep [:tostr $i]]] = "nil") do={ `
      + `:do { ${c} remove $i } on-error={ ${say('warning', `could not remove an entry from ${c}`)} } } }`);
  });

  // Sets and adds, parents first.
  caps.forEach((cap, i) => {
    const def: MenuDef = MENUS[cap.menu];
    const c = cli(def.path);
    const rows = cap.rows.filter(isStatic);

    if (def.mode === 'ordered') {
      // Globals: a long rule list spans chunks.
      const [oldV, newV, okV] = [`${tag}o${i}`, `${tag}n${i}`, `${tag}k${i}`];
      const decl = `:global ${oldV}; :global ${newV}; :global ${okV}`;
      groups.push(`${decl}\n:set ${oldV} ${def.hasDynamic ? `[${c} find where dynamic=no]` : `[${c} find]`}\n`
        + `:set ${newV} [:toarray ""]\n:set ${okV} true`);
      for (const row of rows) {
        groups.push(`${decl}\n:do { :set ${newV} ($${newV}, [${c} add ${assign(settable(def, row))}]) } on-error={ :set ${okV} false }`);
      }
      groups.push(`${decl}\n:if ($${okV}) do={ :foreach r in=$${oldV} do={ :do { ${c} remove $r } on-error={} } } `
        + `else={ :foreach r in=$${newV} do={ :do { ${c} remove $r } on-error={} }; `
        + `${say('error', `could not rebuild ${c}; left as the change made it`)} }`);
      return;
    }

    if (def.mode === 'replace') {
      for (const row of rows) {
        const props = settable(def, row);
        if (!props.length) continue;
        groups.push(`:do { ${c} remove ${row['.id']} } on-error={}\n`
          + `:do { ${c} add ${assign(props)} } on-error={ ${say('warning', `could not add back ${c} ${row['address'] ?? row['.id']}`)} }`);
      }
      return;
    }

    for (const row of rows) {
      const id = row['.id'];
      const props = settable(def, row);
      if (!props.length) continue;
      // Set back also clears what the snapshot didn't have: an empty comment,
      // and `unset` for the rest.
      const clearComment = def.only?.includes('comment') && !('comment' in row) ? [['comment', ''] as [string, string]] : [];
      const unsets = (def.unsetIfAbsent ?? []).filter((k) => !(k in row))
        .map((k) => `; :do { ${c} unset ${id} ${k} } on-error={}`).join('');
      const one = (target: string, [k, v]: [string, string]) => `:do { ${c} set ${target} ${k}=${rosQuote(v)} } on-error={}`;
      const failed = say('warning', `could not set back ${c} ${id}`);
      const setProps = [...props, ...clearComment];
      const setBack = (def.fallback
        ? `:do { ${c} set ${id} ${assign(setProps)} } on-error={ ${setProps.map((p) => one(id, p)).join('; ')} }`
        : `:do { ${c} set ${id} ${assign(setProps)} } on-error={ ${failed} }`) + unsets;
      const exists = `([:len [${c} find where .id=${id}]] > 0)`;
      if (def.mode === 'setOnly') {
        groups.push(`:if ${exists} do={ ${setBack} }`);
        continue;
      }
      const keys = props.filter(([k]) => def.addKeys?.includes(k));
      const rest = props.filter(([k]) => !def.addKeys?.includes(k));
      const notAdded = say('warning', `could not add back ${c} ${keys.map(([, v]) => v).join(' ') || id}`);
      const addBack = def.fallback && keys.length
        ? `:do { ${c} add ${assign(props)} } on-error={ :do { :local n [${c} add ${assign(keys)}]; `
          + `${rest.map((p) => one('$n', p)).join('; ')} } on-error={ ${notAdded} } }`
        : `:do { ${c} add ${assign(props)} } on-error={ ${notAdded} }`;
      groups.push(`:if ${exists} do={ ${setBack} } else={ ${addBack} }`);
    }
  });

  // Pack groups into chunks.
  const chunks: string[] = [];
  let cur = '';
  for (const raw of groups) {
    // Its own scope, so groups in one chunk can reuse local names.
    const g = `{\n${raw}\n}`;
    if (g.length + 1 > CHUNK_MAX) throw new Error('A single restore step is too large for RouterOS.');
    if (cur && cur.length + g.length + 1 > CHUNK_MAX) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + g;
  }
  if (cur) chunks.push(cur);

  const names = chunks.map((_, n) => `${schedulerName}-${n + 1}`);
  const onEvent = [
    `/system scheduler remove [find name=${rosQuote(schedulerName)}]`,
    say('warning', `restoring ${caps.map((cap) => cli(menuPath(cap.menu))).join(', ')} (${schedulerName})`),
    `:foreach s in={${names.map(rosQuote).join(';')}} do={ :do { /system script run [find name=$s] } on-error={ ${say('error', 'a restore step failed')} } }`,
    `:foreach s in=[/system script find where name~${rosQuote(`^${schedulerName}-`)}] do={ :do { /system script remove $s } on-error={} }`,
    // Globals exist only after a firewall rebuild. Reading the environment
    // needs a permission a `write`-group user lacks, so it may fail harmlessly.
    ...(caps.some((cap) => MENUS[cap.menu].mode === 'ordered')
      ? [`:do { :foreach v in=[/system script environment find where name~${rosQuote(`^${tag}`)}] do={ /system script environment remove $v } } on-error={}`]
      : []),
    say('warning', `restore finished (${schedulerName})`),
  ].join('\n');
  return { onEvent, chunks };
}

/** Read the menus of a scope. A menu the device doesn't have (no PoE, say) is left out. */
export async function captureScope(
  execute: (path: string) => Promise<RosRow[]>, scope: MenuKey[],
): Promise<CapturedMenu[]> {
  const out: CapturedMenu[] = [];
  for (const menu of scope) {
    try {
      out.push({ menu, rows: await execute(`${menuPath(menu)}/print`) });
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/no such command|unknown command|no such item/i.test(msg)) continue;
      throw err;
    }
  }
  return out;
}
