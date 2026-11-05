/**
 * Port names short enough to sit under a switch on the map (#367). RouterOS
 * names a bridged port by its path in LLDP ("bridge/bonding/sfp-sfpplus1"),
 * and two of those under one switch ran into each other. The full name is on
 * hover.
 *
 *   bridge/bonding/sfp-sfpplus1 → sfp1          (or bonding·sfp1, keeping the bond)
 *   bridge/ether17              → e17
 *   GigabitEthernet1/0/17       → Gi1/0/17
 *
 * How much to show is a choice in the map's Display popup: the bond a port is
 * in was lost with the bridge in beta.15, and a LAG then looked like a plain
 * cable (#367).
 */

/** Port labels on the map: short with the bond, short, as reported, or none. */
export type PortLabels = 'bond' | 'short' | 'full' | 'off';
export const PORT_LABELS: PortLabels[] = ['bond', 'short', 'full', 'off'];

/** Cisco's own short forms, longest names first. */
const CISCO: [RegExp, string][] = [
  [/^HundredGig(?:abit)?E(?:thernet)?(?=\d)/i, 'Hu'],
  [/^FortyGig(?:abit)?E(?:thernet)?(?=\d)/i, 'Fo'],
  [/^TwentyFiveGig(?:abit)?E(?:thernet)?(?=\d)/i, 'Twe'],
  [/^TenGig(?:abit)?E(?:thernet)?(?=\d)/i, 'Te'],
  [/^GigabitEthernet(?=\d)/i, 'Gi'],
  [/^FastEthernet(?=\d)/i, 'Fa'],
  [/^Port-channel(?=\d)/i, 'Po'],
];

/** A first part that is a bond rather than a bridge, when a path has only two. */
const BOND_LIKE = /^(bond|lag|lacp|po\d|port-channel|ae\d)/i;

const isPath = (parts: string[]) => parts.length > 1 && /^[a-z]/i.test(parts[parts.length - 1]);

function shorten(n: string): string {
  for (const [long, short] of CISCO) {
    if (long.test(n)) return n.replace(long, short);
  }
  return n
    .replace(/^ether(\d+)$/, 'e$1')
    .replace(/^sfp-sfpplus(\d+)$/, 'sfp$1');
}

/**
 * The bond a RouterOS port is in, from its LLDP path: bridge/<bond>/<port>,
 * or <bond>/<port> when the first part is plainly a bond. Null otherwise.
 */
export function bondOf(name: string): string | null {
  const parts = name.trim().split('/');
  if (!isPath(parts)) return null;
  if (parts.length >= 3) return parts[parts.length - 2] || null;
  return BOND_LIKE.test(parts[0]) ? parts[0] : null;
}

export function shortPort(name: string, keepBond = false, knownBond?: string): string {
  let n = name.trim();
  // A path whose last part is a name (bridge/ether17) is the port and what
  // it's in. One whose last part is a number (Gi1/0/17, ge-0/0/1) is a slot
  // and port number, and keeps every part.
  const parts = n.split('/');
  if (isPath(parts)) n = parts[parts.length - 1];
  const port = shorten(n);
  // The bond in the name (LLDP's view of the far end), or the one the
  // device's own bond list puts this port in (the near end).
  const bond = keepBond ? (bondOf(name) ?? knownBond ?? null) : null;
  return bond ? `${shorten(bond)}·${port}` : port;
}

/** A discovered link's label, "a ↔ b", with each end shortened; `bonds` in label order. */
export function shortPortLabel(label: string, keepBond = false, bonds?: (string | undefined)[]): string {
  return label.split(' ↔ ').map((p, i) => shortPort(p, keepBond, bonds?.[i])).join(' ↔ ');
}

/** The label drawn on a link for a Port labels choice; undefined draws none. */
export function portLabel(label: string, mode: PortLabels, bonds?: (string | undefined)[]): string | undefined {
  if (mode === 'off') return undefined;
  if (mode === 'full') return label;
  return shortPortLabel(label, mode === 'bond', bonds);
}
