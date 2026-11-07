import { readRules, analyseRules, routesByTable, prefixCovers, parseRuleInput } from '../routingRules';

const rule = (over: Record<string, string>) => ({ action: 'lookup', disabled: 'false', ...over });
const routes = routesByTable([
  { 'dst-address': '0.0.0.0/0', gateway: '10.0.0.1', active: 'true', 'routing-table': 'EDW' },
  { 'dst-address': '0.0.0.0/0', gateway: '10.0.9.1', active: 'false', 'routing-table': 'DEAD' },
  { 'dst-address': '0.0.0.0/0', gateway: '192.168.0.1', active: 'true' },
]);
const flags = (rows: Record<string, string>[], tables: string[] | null = ['EDW', 'DEAD']) =>
  analyseRules(readRules(rows.map((r, i) => ({ '.id': `*${i + 1}`, ...r }))), tables, routes).map((r) => r.flags.map((f) => f.text).join(' | '));

describe('routing rules (#370)', () => {
  it('flags a copy of an earlier rule (Ron\'s rules 2 and 7)', () => {
    const f = flags([
      rule({ 'src-address': '192.168.51.0/24', table: 'EDW' }),
      rule({ 'src-address': '192.168.52.0/24', table: 'EDW' }),
      rule({ 'src-address': '192.168.52.0/24', table: 'EDW' }),
    ]);
    expect(f[0]).toBe('');
    expect(f[1]).toBe('');
    expect(f[2]).toMatch(/Same as rule 2/);
  });

  it('flags a rule an earlier, wider one covers, whatever its action', () => {
    const f = flags([
      rule({ 'src-address': '192.168.0.0/16', table: 'EDW' }),
      rule({ 'src-address': '192.168.52.0/24', action: 'drop' }),
      rule({ 'src-address': '10.0.0.0/8', 'dst-address': '10.1.0.0/16', table: 'EDW' }),
      rule({ 'src-address': '10.2.0.0/16', table: 'EDW' }),
    ]);
    expect(f[1]).toMatch(/rule 1 matches everything/);
    // The earlier one also needs the destination, so it doesn't cover this.
    expect(f[3]).toBe('');
  });

  it('a disabled rule, or one with min-prefix, covers nothing', () => {
    const f = flags([
      rule({ table: 'EDW', disabled: 'true' }),
      rule({ table: 'main', 'min-prefix': '0' }),
      rule({ 'src-address': '192.168.52.0/24', table: 'EDW' }),
    ]);
    expect(f[2]).toBe('');
  });

  it('flags a missing table, and one with no active routes', () => {
    const f = flags([
      rule({ 'src-address': '1.1.1.1', table: 'NOPE' }),
      rule({ 'src-address': '2.2.2.2', table: 'DEAD', action: 'lookup-only-in-table' }),
      rule({ 'src-address': '3.3.3.3', table: 'DEAD' }),
      rule({ 'src-address': '4.4.4.4', table: 'main' }),
    ]);
    expect(f[0]).toMatch(/NOPE doesn't exist/);
    expect(f[1]).toMatch(/unreachable/);
    expect(f[2]).toMatch(/DEAD has no active routes\.$/);
    expect(f[3]).toBe('');
    // RouterOS 6 has no table list to check against.
    expect(flags([rule({ 'src-address': '1.1.1.1', table: 'NOPE' })], null)[0]).toMatch(/no active routes/);
  });

  it('compares prefixes, IPv4 and IPv6', () => {
    expect(prefixCovers('192.168.0.0/16', '192.168.52.0/24')).toBe(true);
    expect(prefixCovers('192.168.52.0/24', '192.168.0.0/16')).toBe(false);
    expect(prefixCovers('192.168.52.0/24', '192.168.52.7')).toBe(true);
    expect(prefixCovers('2001:db8::/32', '2001:db8:1::/48')).toBe(true);
    expect(prefixCovers('0.0.0.0/0', '2001:db8::/32')).toBe(false);
  });

  it('checks a new rule field by field', () => {
    expect(parseRuleInput({ 'src-address': '192.168.52.0/24', table: 'EDW' })).toEqual({ rule: { action: 'lookup', 'src-address': '192.168.52.0/24', table: 'EDW' } });
    const bad = parseRuleInput({ 'src-address': '192.168.300.0/24', action: 'lookup', table: '' });
    expect('errors' in bad && bad.errors).toMatchObject({ 'src-address': expect.stringMatching(/isn't an address/), table: expect.stringMatching(/Choose the table/) });
    expect(parseRuleInput({ action: 'drop', table: 'ignored' })).toEqual({ rule: { action: 'drop' } });
    const mixed = parseRuleInput({ 'src-address': '10.0.0.0/8', 'dst-address': '2001:db8::/32', action: 'unreachable' });
    expect('errors' in mixed && mixed.errors['dst-address']).toMatch(/both be IPv4/);
    expect('errors' in parseRuleInput({ action: 'jump' })).toBe(true);
  });
});
