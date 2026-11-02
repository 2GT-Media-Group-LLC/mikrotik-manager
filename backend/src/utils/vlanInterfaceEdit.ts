/**
 * Checks for adding and editing VLAN interfaces (#309), turned into RouterOS
 * property names for /interface/vlan. Only what was sent changes.
 */
import { isIP } from 'net';

const NAME = /^[^\s"\\;,]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type VlanInterfaceResult =
  | { fields: Record<string, string>; address: string | null }
  | { error: string };

/** "10.0.20.1/24" or "2001:db8::1/64": an interface address with its prefix. */
export function interfaceAddress(v: string): boolean {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(v);
  if (!m) return false;
  const family = isIP(m[1]);
  const prefix = Number(m[2]);
  return (family === 4 && prefix <= 32) || (family === 6 && prefix <= 128);
}

/** A VLAN interface, to add (`creating`) or change. */
export function vlanInterfaceEntry(body: Record<string, unknown>, creating: boolean): VlanInterfaceResult {
  const fields: Record<string, string> = {};

  if (creating || body.vlan_id !== undefined) {
    const raw = body.vlan_id;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 4094) return { error: 'vlan_id must be a whole number from 1 to 4094' };
    fields['vlan-id'] = String(n);
  }
  if (creating || body.interface !== undefined) {
    const parent = String(body.interface ?? '').trim();
    if (!NAME.test(parent)) return { error: 'interface (the parent the VLAN is tagged on) is required' };
    fields.interface = parent;
  }
  if (creating || body.name !== undefined) {
    const name = String(body.name ?? '').trim() || (creating ? `vlan${fields['vlan-id']}` : '');
    if (!NAME.test(name)) return { error: 'name must be 1 to 64 characters, without spaces, quotes, commas or semicolons' };
    fields.name = name;
  }
  if (body.mtu !== undefined && body.mtu !== null && String(body.mtu).trim() !== '') {
    const mtu = Number(body.mtu);
    if (!Number.isInteger(mtu) || mtu < 64 || mtu > 65535) return { error: 'mtu must be a whole number from 64 to 65535' };
    fields.mtu = String(mtu);
  }
  if (body.comment !== undefined) {
    const comment = String(body.comment ?? '');
    if (comment.length > 255 || CONTROL.test(comment)) return { error: 'comment must be one line of at most 255 characters' };
    fields.comment = comment;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') return { error: 'disabled must be true or false' };
    fields.disabled = body.disabled ? 'yes' : 'no';
  }

  let address: string | null = null;
  if (body.address !== undefined && body.address !== null && String(body.address).trim() !== '') {
    if (!creating) return { error: 'Change its addresses under Config, IP Addresses' };
    address = String(body.address).trim();
    if (!interfaceAddress(address)) return { error: 'address must be an address with its prefix, e.g. 10.0.20.1/24' };
  }

  if (!creating && Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  if (creating && fields.comment === '') delete fields.comment;
  return { fields, address };
}
