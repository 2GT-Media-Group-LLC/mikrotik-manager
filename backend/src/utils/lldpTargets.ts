/**
 * Which device types an LLDP request targets. Pure, so it is testable without
 * a database; see services/lldpApply.ts for why every type is allowed.
 */

export const LLDP_DEVICE_TYPES = ['router', 'switch', 'wireless_ap', 'other'] as const;
export type LldpDeviceType = (typeof LLDP_DEVICE_TYPES)[number];

/** Omitted means every type. Returns null on anything unrecognised. */
export function parseDeviceTypes(v: unknown): LldpDeviceType[] | null {
  if (v === undefined || v === null || v === '') return [...LLDP_DEVICE_TYPES];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const out = list.map((s) => String(s).trim()).filter(Boolean);
  if (!out.length || out.some((t) => !(LLDP_DEVICE_TYPES as readonly string[]).includes(t))) return null;
  return [...new Set(out)] as LldpDeviceType[];
}
