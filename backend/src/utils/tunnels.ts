/**
 * Tunnels and PPP across the fleet (#310): IPsec peers, PPPoE servers and
 * clients, active PPP sessions, and EoIP, GRE and IPIP tunnels, from one
 * batched read per slow poll. Read-only. Pure, so it's tested without a device.
 *
 * Fields are copied one by one into the row, never spread: an EoIP or GRE
 * tunnel carries `ipsec-secret`, and that must not reach the database.
 */

type Ros = Record<string, string>;

export type TunnelKind = 'ipsec' | 'pppoe-server' | 'ppp-session' | 'pppoe-client' | 'eoip' | 'gre' | 'ipip';
/** up: working. down: should work and doesn't. idle: waiting for the far end (a passive peer, a server with no one on it). */
export type TunnelStatus = 'up' | 'down' | 'idle' | 'disabled';

export interface TunnelRow {
  kind: TunnelKind;
  key: string;
  name: string;
  local: string | null;
  remote: string | null;
  detail: string | null;
  status: TunnelStatus;
  /** What RouterOS says, for the badge: established, running, connecting... */
  state: string;
  uptime: string | null;
}

export interface TunnelInput {
  ipsecPeers: Ros[];
  ipsecActive: Ros[];
  pppoeServers: Ros[];
  pppActive: Ros[];
  pppoeClients: Ros[];
  eoip: Ros[];
  gre: Ros[];
  ipip: Ros[];
}

/** A busy access concentrator has thousands of sessions; the table keeps this many per device. */
export const MAX_SESSIONS = 5000;

const yes = (v: string | undefined) => v === 'true' || v === 'yes';
const text = (v: string | undefined) => (v ?? '').trim() || null;

/** IPv4 or IPv6 address as a bigint, or null. */
function ipValue(addr: string): { v: bigint; bits: number } | null {
  const a = addr.trim();
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m4) {
    const o = m4.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    return { v: o.reduce((acc, x) => (acc << 8n) + BigInt(x), 0n), bits: 32 };
  }
  if (!a.includes(':')) return null;
  const [head, tail] = a.split('::');
  if (a.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(fill, 0)).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n), bits: 128 };
}

/** Whether an address falls in a peer's `address` (a prefix, or a lone address). */
export function inPrefix(address: string, prefix: string): boolean {
  const [net, lenRaw] = prefix.split('/');
  const a = ipValue(address);
  const n = ipValue(net ?? '');
  if (!a || !n || a.bits !== n.bits) return false;
  const len = lenRaw === undefined ? n.bits : Number(lenRaw);
  if (!Number.isInteger(len) || len < 0 || len > n.bits) return false;
  const shift = BigInt(n.bits - len);
  return (a.v >> shift) === (n.v >> shift);
}

/** The configured peer an active peer belongs to: the most specific address match, as RouterOS picks. */
function peerFor(remote: string, peers: Ros[]): Ros | undefined {
  let best: Ros | undefined;
  let bestLen = -1;
  for (const p of peers) {
    const prefix = p['address'] || '0.0.0.0/0';
    if (!inPrefix(remote.split('[')[0], prefix)) continue;
    const len = Number(prefix.split('/')[1] ?? (prefix.includes(':') ? 128 : 32));
    if (len > bestLen) { best = p; bestLen = len; }
  }
  return best;
}

function ipsecRows(peers: Ros[], active: Ros[]): TunnelRow[] {
  const enabled = peers.filter((p) => !yes(p['disabled']));
  const byPeer = new Map<Ros, Ros[]>();
  for (const a of active) {
    const p = peerFor(a['remote-address'] ?? '', enabled);
    if (p) byPeer.set(p, [...(byPeer.get(p) ?? []), a]);
  }
  return peers.map((p) => {
    const sas = byPeer.get(p) ?? [];
    const established = sas.filter((a) => a['state'] === 'established');
    const disabled = yes(p['disabled']);
    const passive = yes(p['passive']);
    const status: TunnelStatus = disabled ? 'disabled' : established.length ? 'up' : passive && !sas.length ? 'idle' : 'down';
    const one = established.length === 1 ? established[0] : sas.length === 1 ? sas[0] : undefined;
    const many = sas.length > 1;
    return {
      kind: 'ipsec' as const,
      key: `peer:${p['name'] || p['.id'] || p['address'] || '?'}`,
      name: p['name'] || p['address'] || 'peer',
      local: text(one?.['local-address'] ?? p['local-address']),
      remote: many ? text(p['address']) : text(one?.['remote-address'] ?? p['address']),
      detail: [
        p['exchange-mode'] ? `${p['exchange-mode']}` : null,
        passive ? 'passive' : null,
        yes(p['dynamic']) ? 'dynamic' : null,
        many ? `${established.length} of ${sas.length} connected` : null,
        one?.['ph2-total'] ? `${one['ph2-total']} SA${one['ph2-total'] === '1' ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ') || null,
      status,
      state: disabled ? 'disabled' : established.length ? 'established' : sas[0]?.['state'] || (passive ? 'waiting' : 'not connected'),
      uptime: one?.['uptime'] ? text(one['uptime']) : null,
    };
  });
}

function interfaceTunnel(kind: 'eoip' | 'gre' | 'ipip', t: Ros): TunnelRow {
  const disabled = yes(t['disabled']);
  const running = yes(t['running']);
  return {
    kind,
    key: `${kind}:${t['name'] || t['.id']}`,
    name: t['name'] || kind,
    // 0.0.0.0 (or ::) is "any local address", not an address.
    local: ['0.0.0.0', '::'].includes((t['local-address'] ?? '').trim()) ? null : text(t['local-address']),
    remote: text(t['remote-address']),
    // Never ipsec-secret.
    detail: [
      kind === 'eoip' && t['tunnel-id'] ? `tunnel ${t['tunnel-id']}` : null,
      t['ipsec-secret'] ? 'IPsec' : null,
      t['keepalive'] ? `keepalive ${t['keepalive']}` : null,
    ].filter(Boolean).join(' · ') || null,
    status: disabled ? 'disabled' : running ? 'up' : 'down',
    state: disabled ? 'disabled' : running ? 'running' : 'not running',
    uptime: null,
  };
}

export function tunnelsFrom(input: TunnelInput): TunnelRow[] {
  const rows: TunnelRow[] = [];
  rows.push(...ipsecRows(input.ipsecPeers, input.ipsecActive));

  const sessionsOn = new Map<string, number>();
  for (const s of input.pppActive) {
    if (s['service'] === 'pppoe') sessionsOn.set('pppoe', (sessionsOn.get('pppoe') ?? 0) + 1);
  }
  for (const srv of input.pppoeServers) {
    const disabled = yes(srv['disabled']);
    const name = srv['service-name'] || srv['name'] || 'pppoe';
    // RouterOS doesn't tie a session to a server in /ppp active; with one server
    // every PPPoE session is its own, with several the count is shared.
    const count = sessionsOn.get('pppoe') ?? 0;
    const shared = input.pppoeServers.filter((x) => !yes(x['disabled'])).length > 1;
    rows.push({
      kind: 'pppoe-server',
      key: `pppoe-server:${name}@${srv['interface'] ?? ''}`,
      name,
      local: text(srv['interface']),
      remote: null,
      detail: disabled ? null : `${count} PPPoE session${count === 1 ? '' : 's'}${shared ? ' across all servers' : ''}`,
      status: disabled ? 'disabled' : count ? 'up' : 'idle',
      state: disabled ? 'disabled' : count ? 'serving' : 'no sessions',
      uptime: null,
    });
  }

  for (const s of input.pppActive.slice(0, MAX_SESSIONS)) {
    const service = s['service'] || 'ppp';
    rows.push({
      kind: 'ppp-session',
      key: `${service}:${s['name'] ?? ''}:${s['caller-id'] ?? ''}:${s['.id'] ?? ''}`,
      name: s['name'] || '(no user)',
      local: null,
      // 0.0.0.0: no address given (a server with no pool).
      remote: (s['address'] ?? '').trim() === '0.0.0.0' ? null : text(s['address']),
      detail: [service, s['caller-id'] ? `from ${s['caller-id']}` : null, s['encoding'] || null].filter(Boolean).join(' · '),
      status: 'up',
      state: 'connected',
      uptime: text(s['uptime']),
    });
  }

  for (const c of input.pppoeClients) {
    const disabled = yes(c['disabled']);
    const running = yes(c['running']);
    rows.push({
      kind: 'pppoe-client',
      key: `pppoe-client:${c['name'] || c['.id']}`,
      name: c['name'] || 'pppoe-client',
      local: text(c['interface']),
      remote: text(c['service-name']) ?? text(c['ac-name']),
      detail: c['user'] ? `user ${c['user']}` : null,
      status: disabled ? 'disabled' : running ? 'up' : 'down',
      state: disabled ? 'disabled' : running ? 'connected' : 'not connected',
      uptime: null,
    });
  }

  for (const t of input.eoip) rows.push(interfaceTunnel('eoip', t));
  for (const t of input.gre) rows.push(interfaceTunnel('gre', t));
  for (const t of input.ipip) rows.push(interfaceTunnel('ipip', t));

  // Keys are unique within a device and kind; a duplicate (two unnamed rows) keeps the first.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.kind}\u0000${r.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
