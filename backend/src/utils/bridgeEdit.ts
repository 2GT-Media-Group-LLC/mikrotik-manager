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

/**
 * Why a bridge can't take `mtu`, or null. RouterOS refuses an MTU above the
 * lowest L2 MTU of the bridge's ports with only "could not set mtu" (checked
 * on a CRS3xx running 7.25), so the ports that are too small are named here.
 */
export function bridgeMtuProblem(mtu: string, ports: { name: string; l2mtu: number | null }[]): string | null {
  if (mtu === 'auto') return null;
  const n = Number(mtu);
  const small = ports.filter((p) => p.l2mtu !== null && p.l2mtu < n).sort((a, b) => (a.l2mtu ?? 0) - (b.l2mtu ?? 0));
  if (!small.length) return null;
  const listed = small.slice(0, 4).map((p) => `${p.name} (${p.l2mtu})`).join(', ') + (small.length > 4 ? ` and ${small.length - 4} more` : '');
  const ceiling = small[0].l2mtu;
  return `An MTU of ${n} is more than the L2 MTU of ${small.length === 1 ? 'its port' : 'these ports'}: ${listed}. `
    + `Raise ${small.length === 1 ? 'that port\u2019s' : 'their'} MTU on the Ports tab first (MTM raises the L2 MTU with it), or keep the bridge at ${ceiling} or less.`;
}

export function validBridgeName(name: string): boolean {
  return NAME.test(name);
}
