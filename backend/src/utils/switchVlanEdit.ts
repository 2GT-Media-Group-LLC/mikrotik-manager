/**
 * Checks for edits to the switch chip's own VLAN table and port VLAN settings
 * (#278), turned into RouterOS property names. Only what was sent changes.
 */
const NAME = /^[^\s"\\;,]{1,64}$/;
export const VLAN_MODES = ['disabled', 'fallback', 'check', 'secure'] as const;
export const VLAN_HEADERS = ['leave-as-is', 'add-if-missing', 'always-strip'] as const;

type Result = { fields: Record<string, string> } | { error: string };

function vlanId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 4095 ? n : null;
}

function portList(v: unknown): string | { error: string } {
  if (!Array.isArray(v)) return { error: 'ports must be a list of port names' };
  const names = [...new Set(v.map((p) => String(p).trim()).filter(Boolean))];
  if (names.some((n) => !NAME.test(n))) return { error: 'ports contains a name that is not a valid port name' };
  return names.join(',');
}

/** A switch VLAN entry, to add (`creating`) or change. */
export function switchVlanEntry(body: Record<string, unknown>, creating: boolean): Result {
  const fields: Record<string, string> = {};
  if (creating || body.switch !== undefined) {
    const s = String(body.switch ?? '').trim();
    if (!NAME.test(s)) return { error: 'switch is required, e.g. switch1' };
    fields.switch = s;
  }
  if (creating || body.vlan_id !== undefined) {
    const id = vlanId(body.vlan_id);
    if (id === null) return { error: 'vlan_id must be a whole number from 0 to 4095' };
    fields['vlan-id'] = String(id);
  }
  if (creating || body.ports !== undefined) {
    const ports = portList(body.ports ?? []);
    if (typeof ports !== 'string') return ports;
    if (creating && !ports) return { error: 'Choose at least one port' };
    fields.ports = ports;
  }
  if (body.independent_learning !== undefined) {
    if (typeof body.independent_learning !== 'boolean') return { error: 'independent_learning must be true or false' };
    fields['independent-learning'] = body.independent_learning ? 'yes' : 'no';
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') return { error: 'disabled must be true or false' };
    fields.disabled = body.disabled ? 'yes' : 'no';
  }
  if (Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  return { fields };
}

/** A switch port's VLAN settings. */
export function switchPortVlan(body: Record<string, unknown>): Result {
  const fields: Record<string, string> = {};
  if (body.vlan_mode !== undefined) {
    if (!(VLAN_MODES as readonly string[]).includes(String(body.vlan_mode))) return { error: `vlan_mode must be one of ${VLAN_MODES.join(', ')}` };
    fields['vlan-mode'] = String(body.vlan_mode);
  }
  if (body.vlan_header !== undefined) {
    if (!(VLAN_HEADERS as readonly string[]).includes(String(body.vlan_header))) return { error: `vlan_header must be one of ${VLAN_HEADERS.join(', ')}` };
    fields['vlan-header'] = String(body.vlan_header);
  }
  if (body.default_vlan_id !== undefined) {
    const raw = String(body.default_vlan_id).trim();
    if (raw === 'auto') fields['default-vlan-id'] = 'auto';
    else {
      const id = vlanId(raw);
      if (id === null) return { error: 'default_vlan_id must be auto or a whole number from 0 to 4095' };
      fields['default-vlan-id'] = String(id);
    }
  }
  if (Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  return { fields };
}

export function validPortName(name: string): boolean {
  return NAME.test(name);
}
