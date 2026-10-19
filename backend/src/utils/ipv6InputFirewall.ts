/**
 * The IPv6 side of the "no input firewall" check (#312). IPv6 has its own
 * filter (/ipv6/firewall/filter), so a router with a careful IPv4 input
 * chain can still leave its services open over IPv6.
 *
 * Only asked of a device that has a routable IPv6 address: every device has
 * link-local ones (fe80::/10), which aren't reachable from beyond the link,
 * so flagging those would be noise. Null when it can't be told (the IPv6
 * menus couldn't be read, say IPv6 is switched off).
 */
type Row = Record<string, string>;

const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export function hasRoutableIpv6(addresses: Row[]): boolean {
  return addresses.some((a) => {
    if (isTrue(a['disabled']) || isTrue(a['invalid'])) return false;
    const ip = (a['address'] || '').split('/')[0].toLowerCase();
    return !!ip && !/^fe[89ab]/.test(ip) && ip !== '::1';
  });
}

export function hasInputDrop(rules: Row[]): boolean {
  return rules.some((r) => r['chain'] === 'input' && ['drop', 'reject'].includes(r['action'] ?? '') && !isTrue(r['disabled']));
}

/** True when the device needs flagging: routable IPv6, and no IPv6 input drop or reject. */
export function missingIpv6InputFirewall(addresses: Row[] | null, rules: Row[] | null): boolean | null {
  if (addresses === null || rules === null) return null;
  return hasRoutableIpv6(addresses) && !hasInputDrop(rules);
}
