/**
 * Creating and editing bridges from the Bridges tab (#284), checked and turned
 * into RouterOS property names. Only what was sent changes; an empty comment
 * clears it.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const PROTOCOL_MODES = ['none', 'stp', 'rstp', 'mstp'] as const;
/** The tag the bridge reads as a VLAN (#449): 802.1Q, 802.1ad service tag, or the old 0x9100. */
export const ETHER_TYPES = ['0x8100', '0x88a8', '0x9100'] as const;
export const MVRP_APPLICANT = ['normal-participant', 'non-participant'] as const;
export const MVRP_REGISTRAR = ['normal', 'fixed'] as const;
/** A bridge port's edge setting: auto-detected, or forced, with or without listening for BPDUs. */
export const PORT_EDGE = ['auto', 'yes', 'no', 'yes-discover', 'no-discover'] as const;
export const PORT_P2P = ['auto', 'yes', 'no'] as const;

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
  if (body.ether_type !== undefined) {
    const t = String(body.ether_type).toLowerCase();
    if (!(ETHER_TYPES as readonly string[]).includes(t)) return { error: `ether_type must be one of ${ETHER_TYPES.join(', ')}` };
    fields['ether-type'] = t;
  }
  if (body.mvrp !== undefined) {
    if (typeof body.mvrp !== 'boolean') return { error: 'mvrp must be true or false' };
    fields.mvrp = body.mvrp ? 'yes' : 'no';
  }
  if (Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  return { fields };
}

/**
 * A bridge port's Q-in-Q and MVRP settings (#449): tag stacking (push the
 * port's PVID over whatever tag a frame already has) and how the port takes
 * part in MVRP. And its spanning tree: priority and path cost, edge,
 * point-to-point, BPDU guard, and the restricted role and TCN.
 */
export function parseBridgePortUpdate(body: Record<string, unknown>): Result {
  const fields: Record<string, string> = {};
  if (body.tag_stacking !== undefined) {
    if (typeof body.tag_stacking !== 'boolean') return { error: 'tag_stacking must be true or false' };
    fields['tag-stacking'] = body.tag_stacking ? 'yes' : 'no';
  }
  if (body.mvrp_applicant_state !== undefined) {
    const v = String(body.mvrp_applicant_state);
    if (!(MVRP_APPLICANT as readonly string[]).includes(v)) return { error: `mvrp_applicant_state must be one of ${MVRP_APPLICANT.join(', ')}` };
    fields['mvrp-applicant-state'] = v;
  }
  if (body.mvrp_registrar_state !== undefined) {
    const v = String(body.mvrp_registrar_state);
    if (!(MVRP_REGISTRAR as readonly string[]).includes(v)) return { error: `mvrp_registrar_state must be one of ${MVRP_REGISTRAR.join(', ')}` };
    fields['mvrp-registrar-state'] = v;
  }
  // Spanning tree on the port: which link becomes the root port, and which
  // ports are edges, may never become root, or shut on a BPDU.
  if (body.stp_priority !== undefined && body.stp_priority !== '') {
    const pr = parsePortPriority(body.stp_priority);
    if (!pr) return { error: 'Port priority must be 0 to 240 in steps of 16 (0x00 to 0xF0)' };
    fields.priority = pr;
  }
  // 'default' unsets it: RouterOS then works it out, and doesn't print it.
  if (body.path_cost === 'default') fields['path-cost'] = '';
  else if (body.path_cost !== undefined && body.path_cost !== '') {
    const c = parsePathCost(body.path_cost);
    if (!c) return { error: 'Path cost must be a whole number from 1 to 200000000' };
    fields['path-cost'] = c;
  }
  if (body.edge !== undefined) {
    const v = String(body.edge);
    if (!(PORT_EDGE as readonly string[]).includes(v)) return { error: `edge must be one of ${PORT_EDGE.join(', ')}` };
    fields.edge = v;
  }
  if (body.point_to_point !== undefined) {
    const v = String(body.point_to_point);
    if (!(PORT_P2P as readonly string[]).includes(v)) return { error: `point_to_point must be one of ${PORT_P2P.join(', ')}` };
    fields['point-to-point'] = v;
  }
  for (const [key, prop] of [['bpdu_guard', 'bpdu-guard'], ['restricted_role', 'restricted-role'], ['restricted_tcn', 'restricted-tcn']] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return { error: `${key} must be true or false` };
    fields[prop] = body[key] ? 'yes' : 'no';
  }
  if (Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  return { fields };
}

/** A bridge port's STP priority: 0–240 in steps of 16, as decimal or RouterOS's hex (0x80). */
export function parsePortPriority(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  const n = /^0x[0-9a-f]{1,2}$/.test(s) ? parseInt(s, 16) : /^\d{1,3}$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 240 || n % 16 !== 0) return null;
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/** A bridge port's STP path cost: 1 to 200000000. */
export function parsePathCost(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 200_000_000 ? String(n) : null;
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
