/**
 * Port names short enough to sit under a switch on the map (#367). RouterOS
 * names a bridged port by its path in LLDP ("bridge/bonding/sfp-sfpplus1"),
 * and two of those under one switch ran into each other. The full name is on
 * hover.
 *
 *   bridge/bonding/sfp-sfpplus1 → sfp1
 *   bridge/ether17              → e17
 *   GigabitEthernet1/0/17       → Gi1/0/17
 */

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

export function shortPort(name: string): string {
  let n = name.trim();
  // A path whose last part is a name (bridge/ether17) is the port and what
  // it's in. One whose last part is a number (Gi1/0/17, ge-0/0/1) is a slot
  // and port number, and keeps every part.
  const parts = n.split('/');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^[a-z]/i.test(last)) n = last;
  for (const [long, short] of CISCO) {
    if (long.test(n)) return n.replace(long, short);
  }
  return n
    .replace(/^ether(\d+)$/, 'e$1')
    .replace(/^sfp-sfpplus(\d+)$/, 'sfp$1');
}

/** A discovered link's label, "a ↔ b", with each end shortened. */
export function shortPortLabel(label: string): string {
  return label.split(' ↔ ').map(shortPort).join(' ↔ ');
}
