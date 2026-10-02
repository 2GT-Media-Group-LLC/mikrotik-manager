import { configuredServices, allowedFrom, allowedFromKey, parseAllowedList, addressAllowed, managerPeer, type ServiceRow } from '../ipServices';

// As RouterOS 7.24 prints them (read from a CRS on the test bench): the
// configured api-ssl, then our own live session as a dynamic row.
const rows: ServiceRow[] = [
  { '.id': '*7', name: 'api', port: '8728', 'available-from': '10.0.0.0/8,192.168.0.0/24', dynamic: 'false', disabled: 'false' },
  { '.id': '*9', name: 'api-ssl', port: '8729', 'available-from': '', dynamic: 'false', disabled: 'false' },
  { '.id': '*2CA', name: 'api-ssl', port: '8729', local: '192.168.0.51', remote: '192.168.0.76:53195', dynamic: 'true', connection: 'true', disabled: 'false' },
];

describe('ip services (#192)', () => {
  it('drops live-connection rows', () => {
    expect(configuredServices(rows).map((r) => r['.id'])).toEqual(['*7', '*9']);
  });
  it('reads available-from, falling back to address on older RouterOS', () => {
    expect(allowedFrom(rows[0])).toEqual(['10.0.0.0/8', '192.168.0.0/24']);
    expect(allowedFrom({ name: 'api', address: '172.16.0.0/12' })).toEqual(['172.16.0.0/12']);
    expect(allowedFromKey(rows[0])).toBe('available-from');
    expect(allowedFromKey({ name: 'api', address: '' })).toBe('address');
  });
  it('validates lists', () => {
    expect(parseAllowedList(' 10.0.0.0/8 , 2001:db8::/32 192.168.1.5')).toEqual({ list: ['10.0.0.0/8', '2001:db8::/32', '192.168.1.5'] });
    expect(parseAllowedList('')).toEqual({ list: [] });
    expect(parseAllowedList('10.0.0.0/33')).toHaveProperty('error');
    expect(parseAllowedList('bogus,10.0.0.1')).toHaveProperty('error');
    expect(parseAllowedList(5)).toHaveProperty('error');
  });
  it('matches addresses against IPv4 and IPv6 prefixes', () => {
    expect(addressAllowed('192.168.0.76', ['10.0.0.0/8', '192.168.0.0/24'])).toBe(true);
    expect(addressAllowed('192.168.1.76', ['192.168.0.0/24'])).toBe(false);
    expect(addressAllowed('192.168.0.76', [])).toBe(true);
    expect(addressAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(addressAllowed('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(addressAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(addressAllowed('10.1.2.3', ['10.1.2.3'])).toBe(true);
  });
  it("finds the manager's address from its own connection", () => {
    expect(managerPeer(rows, 'api-ssl')).toBe('192.168.0.76');
    const two = [...rows, { name: 'api-ssl', remote: '192.168.0.9:4000', dynamic: 'true' }];
    expect(managerPeer(two, 'api-ssl')).toBeNull(); // ambiguous
    expect(managerPeer(two, 'api-ssl', 53195)).toBe('192.168.0.76');
    expect(managerPeer(rows, 'api')).toBeNull();
  });
});
