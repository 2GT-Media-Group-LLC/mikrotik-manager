/**
 * Matching for the searchable device picker (#304). Every word typed must
 * appear in the device's name, address, site, model or identity, in any
 * order, so "core 10.2" or "amsterdam crs" both narrow a large fleet quickly.
 */
export interface PickerDevice {
  id: number;
  name: string;
  ip_address?: string | null;
  site_id?: number | null;
  /** Filled in by the picker from site_id where the row doesn't carry it. */
  site_name?: string | null;
  model?: string | null;
  ros_identity?: string | null;
  status?: string | null;
  device_type?: string | null;
}

export function pickerHaystack(d: PickerDevice): string {
  return [d.name, d.ip_address, d.site_name, d.model, d.ros_identity, d.device_type]
    .filter(Boolean).join(' ').toLowerCase();
}

/**
 * The devices matching `text`, best first: name starts with what was typed,
 * then name contains it, then a match anywhere else; ties keep the caller's
 * order (usually by name).
 */
export function filterDevices<T extends PickerDevice>(devices: T[], text: string): T[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return devices;
  const first = words[0];
  const scored: { d: T; rank: number; i: number }[] = [];
  devices.forEach((d, i) => {
    const hay = pickerHaystack(d);
    if (!words.every((w) => hay.includes(w))) return;
    const name = d.name.toLowerCase();
    const rank = name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2;
    scored.push({ d, rank, i });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((s) => s.d);
}

/** How many rows the open list renders; past this, typing narrows it. */
export const PICKER_RENDER_LIMIT = 200;
