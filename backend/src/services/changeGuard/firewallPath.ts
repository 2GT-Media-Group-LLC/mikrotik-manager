/**
 * Does the IPv4 input chain let the manager in?
 *
 * The earlier check looked at rules one at a time and flagged any unscoped
 * input-chain drop. That ignored order, so moving a drop above the rule that
 * accepts the manager, or deleting that accept rule, went unnoticed. It also
 * flagged RouterOS's own default config ("drop everything not from LAN"), which
 * left the check permanently failing on most devices and therefore unable to
 * notice a new break (outside review P2-8).
 *
 * This walks the input chain the way RouterOS does, first match wins, for the
 * connection the manager actually opens: a new TCP connection from its address
 * to the API port, arriving on the interface that owns the management address.
 * Each matcher answers yes, no or maybe. "Maybe" is kept honest all the way
 * through: a definite drop after a rule that maybe accepted is "unknown", not
 * "dropped", and the reverse.
 */
import type { DeviceSnapshot, RosRow } from './pathModel';

export type Tri = 'yes' | 'no' | 'maybe';

export interface MgmtConnection {
  /** The manager's address as the device sees it; null when unknown. */
  srcIp: string | null;
  /** The address the manager connects to. */
  dstIp: string;
  dstPort: number;
  /** Interface that owns the management address (a bridge, VLAN interface or port). */
  inInterface: string | null;
}

export interface ChainVerdict {
  outcome: 'accepted' | 'dropped' | 'unknown';
  /** Index of the deciding rule in the filter table, as RouterOS numbers it. */
  ruleIndex?: number;
  reason: string;
}

/** Fields that describe a rule rather than restrict what it matches. */
const NEUTRAL_KEYS = new Set([
  '.id', '.nextid', 'chain', 'action', 'comment', 'disabled', 'dynamic', 'invalid',
  'log', 'log-prefix', 'bytes', 'packets', 'jump-target', 'reject-with',
  'address-list', 'address-list-timeout', 'place-before', 'passthrough', 'place-after',
]);

const DROP_ACTIONS = new Set(['drop', 'reject', 'tarpit']);
const CONTINUE_ACTIONS = new Set([
  'passthrough', 'log', 'add-src-to-address-list', 'add-dst-to-address-list', 'fasttrack-connection',
]);
const MAX_JUMP_DEPTH = 8;

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';

function negated(spec: string): { neg: boolean; value: string } {
  const t = spec.trim();
  return t.startsWith('!') ? { neg: true, value: t.slice(1).trim() } : { neg: false, value: t };
}

function flip(t: Tri, neg: boolean): Tri {
  if (!neg || t === 'maybe') return t;
  return t === 'yes' ? 'no' : 'yes';
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Is `ip` inside a RouterOS address spec: "10.0.0.1", "10.0.0.0/8" or
 * "10.0.0.1-10.0.0.9"? Anything else (a DNS name, IPv6) is "maybe".
 */
export function addressMatches(spec: string, ip: string | null): Tri {
  if (!ip) return 'maybe';
  const target = ipv4ToInt(ip);
  if (target === null) return 'maybe';
  const s = spec.trim();
  if (s.includes('-')) {
    const [a, b] = s.split('-').map((x) => ipv4ToInt(x));
    if (a === null || b === null) return 'maybe';
    return target >= Math.min(a, b) && target <= Math.max(a, b) ? 'yes' : 'no';
  }
  const [base, bitsStr] = s.split('/');
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return 'maybe';
  const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return 'maybe';
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((target & mask) >>> 0) === ((baseInt & mask) >>> 0) ? 'yes' : 'no';
}

/** Does a RouterOS port spec ("22", "80,443", "8000-8100") include `port`? */
export function portMatches(spec: string, port: number): Tri {
  let sawNumber = false;
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map((n) => parseInt(n, 10));
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 'maybe';
      sawNumber = true;
      if (port >= lo && port <= hi) return 'yes';
    } else {
      const n = parseInt(part, 10);
      if (!Number.isFinite(n)) return 'maybe'; // a service name such as "ssh"
      sawNumber = true;
      if (n === port) return 'yes';
    }
  }
  return sawNumber ? 'no' : 'maybe';
}

/** Membership of `ip` in a firewall address list, from the snapshot. */
function inAddressList(snap: DeviceSnapshot, list: string, ip: string | null): Tri {
  // Only lists the snapshot actually read can say "no". A list that was too
  // big to read, or that a simulated change introduces, stays "maybe".
  if (!(snap.addressListsRead ?? []).includes(list)) return 'maybe';
  const entries = (snap.addressLists ?? []).filter((e) => e['list'] === list && !isTrue(e['disabled']));
  let result: Tri = 'no';
  for (const e of entries) {
    const m = addressMatches(e['address'] || '', ip);
    if (m === 'yes') return 'yes';
    if (m === 'maybe') result = 'maybe';
  }
  return result;
}

/** Membership of an interface in an interface list, from the snapshot. */
function inInterfaceList(snap: DeviceSnapshot, list: string, iface: string | null): Tri {
  if (list === 'all') return 'yes';
  if (list === 'none') return 'no';
  if (!iface) return 'maybe';
  // Built-in dynamic lists, and lists that include or exclude other lists, are
  // not expanded here.
  if (list === 'dynamic' || list === 'static') return 'maybe';
  const def = (snap.interfaceLists ?? []).find((l) => l['name'] === list);
  if (!def || (def['include'] || '').trim() || (def['exclude'] || '').trim()) return 'maybe';
  const members = (snap.interfaceListMembers ?? []).filter((m) => m['list'] === list && !isTrue(m['disabled']));
  return members.some((m) => m['interface'] === iface) ? 'yes' : 'no';
}

/** Combine matcher answers: every matcher must say yes. */
function all(results: Tri[]): Tri {
  if (results.includes('no')) return 'no';
  return results.includes('maybe') ? 'maybe' : 'yes';
}

/** Would this rule's matchers match the manager's new connection? */
export function ruleMatches(rule: RosRow, conn: MgmtConnection, snap: DeviceSnapshot): Tri {
  const results: Tri[] = [];
  for (const [key, raw] of Object.entries(rule)) {
    if (NEUTRAL_KEYS.has(key) || raw === undefined || raw === '') continue;
    const { neg, value } = negated(raw);
    switch (key) {
      case 'protocol': {
        const p = value.toLowerCase();
        results.push(flip(p === 'tcp' || p === '6' ? 'yes' : 'no', neg));
        break;
      }
      case 'dst-port': results.push(flip(portMatches(value, conn.dstPort), neg)); break;
      case 'src-address': results.push(flip(addressMatches(value, conn.srcIp), neg)); break;
      case 'dst-address': results.push(flip(addressMatches(value, conn.dstIp), neg)); break;
      case 'src-address-list': results.push(flip(inAddressList(snap, value, conn.srcIp), neg)); break;
      case 'dst-address-list': results.push(flip(inAddressList(snap, value, conn.dstIp), neg)); break;
      case 'in-interface':
        results.push(conn.inInterface ? flip(value === conn.inInterface ? 'yes' : 'no', neg) : 'maybe');
        break;
      case 'in-interface-list': results.push(flip(inInterfaceList(snap, value, conn.inInterface), neg)); break;
      case 'connection-state': {
        // The manager opens a fresh connection for every poll and for Change
        // Guard's own verification, so what matters is a new connection.
        const states = value.split(',').map((x) => x.trim());
        results.push(flip(states.includes('new') ? 'yes' : 'no', neg));
        break;
      }
      default:
        // Anything not modelled (tcp-flags, limits, marks, time, src-port...)
        // could go either way.
        results.push('maybe');
    }
    if (results[results.length - 1] === 'no') return 'no';
  }
  return all(results);
}

type ChainResult =
  | { kind: 'accept' | 'drop'; ruleIndex: number; maybe: boolean }
  | { kind: 'continue'; maybeAccept: boolean; maybeDrop: boolean; ruleIndex?: number };

function walkChain(
  snap: DeviceSnapshot, conn: MgmtConnection, chain: string, depth: number,
): ChainResult {
  let maybeAccept = false;
  let maybeDrop = false;
  let maybeRule: number | undefined;
  for (const [i, rule] of snap.firewallFilter.entries()) {
    if (rule['chain'] !== chain || isTrue(rule['disabled']) || isTrue(rule['invalid'])) continue;
    const action = (rule['action'] || 'accept').toLowerCase();
    if (CONTINUE_ACTIONS.has(action)) continue;
    const match = ruleMatches(rule, conn, snap);
    if (match === 'no') continue;

    let effect: 'accept' | 'drop' | 'return' | 'both' | 'none';
    if (action === 'accept') effect = 'accept';
    else if (DROP_ACTIONS.has(action)) effect = 'drop';
    else if (action === 'return') effect = 'return';
    else if (action === 'jump') {
      const target = rule['jump-target'];
      if (!target || depth >= MAX_JUMP_DEPTH) effect = 'both';
      else {
        const sub = walkChain(snap, conn, target, depth + 1);
        if (sub.kind === 'continue') {
          if (sub.maybeAccept) { maybeAccept = true; maybeRule ??= sub.ruleIndex; }
          if (sub.maybeDrop) { maybeDrop = true; maybeRule ??= sub.ruleIndex; }
          continue;
        }
        if (sub.maybe || match === 'maybe') {
          if (sub.kind === 'accept') maybeAccept = true; else maybeDrop = true;
          maybeRule ??= sub.ruleIndex;
          continue;
        }
        effect = sub.kind;
        if (effect === 'accept' || effect === 'drop') {
          return maybeFor(effect, sub.ruleIndex);
        }
      }
    } else effect = 'both'; // an action we don't model

    if (match === 'maybe') {
      if (effect === 'accept' || effect === 'return') maybeAccept = true;
      else if (effect === 'drop') maybeDrop = true;
      else { maybeAccept = true; maybeDrop = true; }
      maybeRule ??= i;
      continue;
    }
    // A definite match.
    if (effect === 'return') return { kind: 'continue', maybeAccept, maybeDrop, ruleIndex: maybeRule };
    if (effect === 'accept' || effect === 'drop') return maybeFor(effect, i);
    maybeAccept = true; maybeDrop = true; maybeRule ??= i;
  }
  return { kind: 'continue', maybeAccept, maybeDrop, ruleIndex: maybeRule };

  function maybeFor(kind: 'accept' | 'drop', ruleIndex: number): ChainResult {
    // A definite decision is only definite if nothing earlier might have
    // decided the other way.
    const conflicted = kind === 'accept' ? maybeDrop : maybeAccept;
    return { kind, ruleIndex: conflicted ? (maybeRule ?? ruleIndex) : ruleIndex, maybe: conflicted };
  }
}

function describe(snap: DeviceSnapshot, index: number | undefined): string {
  if (index === undefined) return 'a rule';
  const rule = snap.firewallFilter.at(index);
  const comment = rule?.['comment'] ? ` ("${rule['comment']}")` : '';
  return `rule ${index}${comment}`;
}

/** Walk the input chain for the manager's connection. */
export function evaluateInputChain(snap: DeviceSnapshot, conn: MgmtConnection): ChainVerdict {
  // The IPv4 filter does not see a manager that connects over IPv6.
  if (conn.dstIp.includes(':')) {
    return { outcome: 'accepted', reason: 'The manager connects over IPv6, which the IPv4 firewall does not filter.' };
  }
  const r = walkChain(snap, conn, 'input', 0);
  const port = conn.dstPort;
  if (r.kind === 'accept' && !r.maybe) {
    return { outcome: 'accepted', ruleIndex: r.ruleIndex, reason: `${describe(snap, r.ruleIndex)} accepts the manager on port ${port}.` };
  }
  if (r.kind === 'drop' && !r.maybe) {
    const action = (snap.firewallFilter.at(r.ruleIndex)?.['action'] || 'drop').toLowerCase();
    return {
      outcome: 'dropped',
      ruleIndex: r.ruleIndex,
      reason: `Firewall ${describe(snap, r.ruleIndex)} in the input chain would ${action} the manager's connection to port ${port}.`,
    };
  }
  if (r.kind === 'continue' && !r.maybeDrop) {
    return { outcome: 'accepted', reason: `No input-chain rule blocks the manager on port ${port}.` };
  }
  const decider = r.ruleIndex === undefined ? undefined : snap.firewallFilter.at(r.ruleIndex);
  const bySource = !!decider && !!(decider['src-address'] || decider['src-address-list']);
  const why = bySource && !conn.srcIp
    // Connection tracking is off (RouterOS turns it on only once firewall rules
    // exist), so the device doesn't tell us the manager's address.
    ? `which matches on the source address, and the manager's address as this device sees it isn't known ` +
      `(connection tracking is off)`
    : `which matches on something this check can't evaluate`;
  return {
    outcome: 'unknown',
    ruleIndex: r.ruleIndex,
    reason: `Whether the manager can still connect on port ${port} depends on ${describe(snap, r.ruleIndex)}, ${why}.`,
  };
}

/**
 * Address lists named by any filter rule, disabled ones included: enabling a
 * disabled rule is one of the changes being simulated.
 */
export function referencedAddressLists(filter: RosRow[]): string[] {
  const names = new Set<string>();
  for (const r of filter) {
    for (const v of [r['src-address-list'], r['dst-address-list']]) {
      if (v) names.add(negated(v).value);
    }
  }
  return [...names];
}
