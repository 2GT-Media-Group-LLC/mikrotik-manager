import { missingIpv6InputFirewall } from '../ipv6InputFirewall';

const global6 = { address: '2001:db8:1::1/64', interface: 'ether1' };
const linkLocal = { address: 'fe80::1/64', interface: 'ether1' };

describe('IPv6 input firewall check (#312)', () => {
  it('flags routable IPv6 with no input drop', () => {
    expect(missingIpv6InputFirewall([global6, linkLocal], [{ chain: 'forward', action: 'drop' }])).toBe(true);
  });
  it('is satisfied by an enabled input drop or reject', () => {
    expect(missingIpv6InputFirewall([global6], [{ chain: 'input', action: 'drop' }])).toBe(false);
    expect(missingIpv6InputFirewall([global6], [{ chain: 'input', action: 'reject' }])).toBe(false);
  });
  it('a disabled rule does not count', () => {
    expect(missingIpv6InputFirewall([global6], [{ chain: 'input', action: 'drop', disabled: 'true' }])).toBe(true);
  });
  it('link-local only, or disabled addresses, are not flagged', () => {
    expect(missingIpv6InputFirewall([linkLocal], [])).toBe(false);
    expect(missingIpv6InputFirewall([{ ...global6, disabled: 'true' }], [])).toBe(false);
  });
  it('says nothing when the IPv6 menus could not be read', () => {
    expect(missingIpv6InputFirewall(null, [])).toBeNull();
    expect(missingIpv6InputFirewall([global6], null)).toBeNull();
  });
});
