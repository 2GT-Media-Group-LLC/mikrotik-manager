/**
 * Creating and editing bridges from the Bridges tab (#284), checked and turned
 * into RouterOS property names. Only what was sent changes; an empty comment
 * clears it.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const PROTOCOL_MODES = ['none', 'stp', 'rstp', 'mstp'] as const;

type Result = { fields: Record<string, string> } | { error: string };

/** STP priority: 0–61440 in steps of 4096, as decimal or RouterOS's hex (0x8000). */
export function parsePriority(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  const n = /^0x[0-9a-f]{1,4}$/.test(s) ? parseInt(s, 16) : /^\d{1,5}$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 61440 || n % 4096 !== 0) return null;
  return `0x${n.toString(16).padStart(4, '0')}`;
}

function common(body: Record<string, unknown>, fields: Record<string, string>): string | null {
  if (body.protocol_mode !== undefined) {
    const m = String(body.protocol_mode);
    if (!(PROTOCOL_MODES as readonly string[]).includes(m)) return `protocol_mode must be one of ${PROTOCOL_MODES.join(', ')}`;
    fields['protocol-mode'] = m;
  }
  if (body.priority !== undefined && body.priority !== '') {
    const p = parsePriority(body.priority);
    if (!p) return 'priority must be 0 to 61440 in steps of 4096 (0x0000 to 0xF000)';
    fields.priority = p;
  }
  if (body.comment !== undefined) {
    const c = String(body.comment);
    if (c.length > 255) return 'comment is at most 255 characters';
    fields.comment = c;
  }
  return null;
}

export function parseBridgeCreate(body: Record<string, unknown>): Result {
  const name = String(body.name ?? '').trim();
  if (!NAME.test(name)) return { error: 'Name is required: letters, digits, dot, dash or underscore, up to 63 characters' };
  const fields: Record<string, string> = { name, 'protocol-mode': 'rstp' };
  const err = common(body, fields);
  if (err) return { error: err };
  if (body.vlan_filtering !== undefined) {
    if (typeof body.vlan_filtering !== 'boolean') return { error: 'vlan_filtering must be true or false' };
    fields['vlan-filtering'] = body.vlan_filtering ? 'yes' : 'no';
  }
  if (fields.comment === '') delete fields.comment;
  return { fields };
}

export function parseBridgeUpdate(body: Record<string, unknown>): Result {
  const fields: Record<string, string> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!NAME.test(name)) return { error: 'Name: letters, digits, dot, dash or underscore, up to 63 characters' };
    fields.name = name;
  }
  const err = common(body, fields);
  if (err) return { error: err };
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') return { error: 'disabled must be true or false' };
    fields.disabled = body.disabled ? 'yes' : 'no';
  }
  if (body.mtu !== undefined) {
    const m = parseBridgeMtu(body.mtu);
    if (!m) return { error: 'MTU: auto, or a number from 576 to 65535' };
    fields.mtu = m;
  }
  if (Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  return { fields };
}

/** A bridge MTU: "auto" (RouterOS's default, the lowest of its ports') or a number. */
export function parseBridgeMtu(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'auto') return 'auto';
  if (!/^\d{3,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 576 && n <= 65535 ? String(n) : null;
}

const portList = (ps: { name: string; l2mtu: number | null }[], n: (p: { l2mtu: number | null; maxL2mtu?: number | null }) => number | null) =>
  ps.slice(0, 4).map((p) => `${p.name} (${n(p)})`).join(', ') + (ps.length > 4 ? ` and ${ps.length - 4} more` : '');

/**
 * Why a bridge can't take `mtu`, or null. RouterOS refuses an MTU above the
 * lowest L2 MTU of the bridge's ports with only "could not set mtu" (checked
 * on a CRS3xx running 7.25), so the ports that are too small are named here:
 * those that can be raised, and those whose hardware can't (a CRS510's
 * management port stops at 2028), which have to leave the bridge instead.
 * The bridge's MTU is only its own traffic; ports switch jumbo frames between
 * themselves on their own MTUs whatever it is.
 */
export function bridgeMtuProblem(mtu: string, ports: { name: string; l2mtu: number | null; maxL2mtu?: number | null }[]): string | null {
  if (mtu === 'auto') return null;
  const n = Number(mtu);
  const small = ports.filter((p) => p.l2mtu !== null && p.l2mtu < n).sort((a, b) => (a.l2mtu ?? 0) - (b.l2mtu ?? 0));
  if (!small.length) return null;
  const capped = small.filter((p) => typeof p.maxL2mtu === 'number' && p.maxL2mtu < n);
  const raisable = small.filter((p) => !capped.includes(p));
  const parts = [`An MTU of ${n} is more than the bridge's ports can carry.`];
  if (raisable.length) {
    parts.push(`Raise the MTU of ${portList(raisable, (p) => p.l2mtu)} on the Ports tab first (MTM raises the L2 MTU with it).`);
  }
  if (capped.length) {
    parts.push(`${portList(capped, (p) => p.maxL2mtu ?? null)} can't go that high (the most ${capped.length === 1 ? 'its' : 'their'} hardware takes), `
      + `so take ${capped.length === 1 ? 'it' : 'them'} out of the bridge, or keep the bridge at ${Math.min(...capped.map((p) => p.maxL2mtu as number))} or less.`);
  } else {
    parts.push(`Or keep the bridge at ${small[0].l2mtu} or less.`);
  }
  parts.push('Ports switch jumbo frames between themselves on their own MTUs; the bridge\u2019s is only for the router\u2019s own traffic on it.');
  return parts.join(' ');
}

export function validBridgeName(name: string): boolean {
  return NAME.test(name);
}
