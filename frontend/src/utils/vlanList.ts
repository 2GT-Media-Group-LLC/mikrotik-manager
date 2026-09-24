/**
 * The tagged-VLAN list on a trunk port, as text (#165).
 *
 * The text form stays the source of truth because it is what people copy from
 * one switch and paste into the next. The checkboxes in the port editor read
 * and write this same string.
 *
 * Ranges are accepted because RouterOS prints VLAN lists that way ("10-20,30"),
 * so a list copied from a terminal pastes in cleanly.
 */

/** Sorted, de-duplicated VLAN ids from "10, 20-22,30". Anything invalid is dropped. */
export function parseVlanList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a >= 1 && b <= 4094 && a <= b && b - a <= 4094) for (let v = a; v <= b; v++) out.add(v);
      continue;
    }
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= 4094) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** Back to text, collapsing consecutive runs into ranges so the string stays short. */
export function formatVlanList(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(','));
    i = j;
  }
  return parts.join(',');
}

/** Add or remove one VLAN, returning the new text. */
export function toggleVlan(text: string, id: number): string {
  const ids = parseVlanList(text);
  return formatVlanList(ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]);
}
