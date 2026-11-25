/**
 * Why a static route's destination or gateway can't be added, or null. Checked
 * before Change Guard runs, so Review changes flags it instead of the router
 * refusing it at apply (10.100.32.256/24, #505). The form checks the same.
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function routeInputProblem(dstAddress: string, gateway: string): string | null {
  const dst = dstAddress.trim();
  const [ip, len, ...rest] = dst.split('/');
  if (rest.length || !IPV4.test(ip) || (len !== undefined && !(/^\d{1,2}$/.test(len) && Number(len) <= 32))) {
    return `${dst} is not a valid destination. Use an IPv4 network with a prefix length, such as 10.100.32.0/24, or 0.0.0.0/0 for the default route.`;
  }
  // A gateway is an address or an interface name; one that reads as an address must be one.
  const gw = gateway.trim().split('%')[0];
  if (/^[\d.]+$/.test(gw) && !IPV4.test(gw)) {
    return `${gateway.trim()} is not a valid gateway address.`;
  }
  return null;
}
