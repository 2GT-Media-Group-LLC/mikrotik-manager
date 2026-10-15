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
  if (Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  return { fields };
}

export function validBridgeName(name: string): boolean {
  return NAME.test(name);
}
