/**
 * A bridge port's spanning-tree settings in the Bridges tab: checked here as
 * the server checks them, so a bad value is shown at the field rather than
 * refused on save.
 */

/** 0–240 in steps of 16, decimal or hex (0x80), as a number; null if it isn't one. */
export function portPriorityValue(v: string): number | null {
  const s = v.trim().toLowerCase();
  const n = /^0x[0-9a-f]{1,2}$/.test(s) ? parseInt(s, 16) : /^\d{1,3}$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 240 && n % 16 === 0 ? n : null;
}

export function portPriorityError(v: string): string | null {
  if (!v.trim()) return null;
  return portPriorityValue(v) == null ? '0 to 240 in steps of 16 (0x00 to 0xF0)' : null;
}

export function pathCostError(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return /^\d{1,9}$/.test(s) && n >= 1 && n <= 200_000_000 ? null : 'A whole number from 1 to 200000000';
}

/**
 * Why BPDU guard would cut this port off, or null. A port that's the root,
 * alternate or backup port is hearing BPDUs from a switch right now, and BPDU
 * guard shuts a port the moment one arrives.
 */
export function bpduGuardWarning(role: string | null | undefined): string | null {
  const r = (role ?? '').replace(/-port$/, '');
  return r === 'root' || r === 'alternate' || r === 'backup'
    ? `This port is the ${r} port, so a switch is sending it BPDUs: BPDU guard would shut it.`
    : null;
}
