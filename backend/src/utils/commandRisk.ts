/**
 * Bulk commands that can change how a device is reached, and so deserve a
 * warning, and with Change Guard off an explicit acknowledgement (outside
 * review U3). Matching is deliberately broad: a false warning costs a click,
 * a missed one can strand a fleet.
 */
const RISKY_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\/ip\/?\s*address\b[\s\S]*?\b(remove|set|disable)\b/i, why: 'changes IP addressing, which can remove the management address' },
  { pattern: /\/ip\/?\s*route\b[\s\S]*?\b(remove|set|disable)\b/i, why: 'changes routing, which can cut the path back to this server' },
  { pattern: /\/ip\/?\s*firewall/i, why: 'edits firewall rules, which can block management access' },
  { pattern: /\/interface\b[\s\S]*?\b(disable|remove)\b/i, why: 'disables or removes an interface, bridge port or VLAN, possibly the one in use' },
  { pattern: /\bdisabled=(yes|true)\b/i, why: 'disables something, possibly on the management path' },
  { pattern: /vlan-filtering\s*=/i, why: 'changes bridge VLAN filtering, the most common way to lose a switch' },
  { pattern: /\/interface\/?\s*bridge\/?\s*(port|vlan)\b[\s\S]*?\bset\b/i, why: 'changes bridge port or VLAN membership' },
  { pattern: /\b(pvid|frame-types)\s*=/i, why: 'changes port VLAN tagging, which can move management to another VLAN' },
  { pattern: /\/ip\/?\s*dhcp-client\b[\s\S]*?\b(remove|disable|set)\b/i, why: 'changes the DHCP client, which can drop the management address' },
  { pattern: /\/system\/?\s*(reboot|shutdown|reset-configuration)/i, why: 'reboots, shuts down or resets the device' },
  { pattern: /\/system\/?\s*package\b[\s\S]*?\b(downgrade|disable|uninstall)\b/i, why: 'changes installed packages' },
  { pattern: /\/user\b[\s\S]*?\b(remove|set|disable)\b/i, why: 'changes user accounts, which can revoke this server’s access' },
  { pattern: /\/ip\/?\s*service\b[\s\S]*?\b(disable|set|remove)\b/i, why: 'changes management services such as the API or SSH' },
  { pattern: /\/certificate\b[\s\S]*?\bremove\b/i, why: 'removes a certificate, possibly the one API-SSL uses' },
];

export function assessCommand(command: string): { risky: boolean; reasons: string[] } {
  const reasons = [...new Set(RISKY_PATTERNS.filter((r) => r.pattern.test(command)).map((r) => r.why))];
  return { risky: reasons.length > 0, reasons };
}
