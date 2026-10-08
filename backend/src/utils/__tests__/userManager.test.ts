import { pickUsers, pickRouters, pickGroups, pickSettings, pickSessions, splitAttributes, matchNasToDevices, isItemId, SECRET_FIELDS } from '../userManager';

// From the #251 reporter's CHR (7.24.5), with a password and shared secret
// added as a release might return them, to prove they never get through.
const users: Record<string, string>[] = [
  { '.id': '*1', name: 'f.last', group: 'Full', 'shared-users': 'unlimited', attributes: '', password: 'hunter2', 'otp-secret': 'JBSWY3DP' },
  { '.id': '*2', name: 'admin', group: 'Cisco Priv', 'shared-users': 'unlimited', attributes: '' },
];
const routers: Record<string, string>[] = [
  { '.id': '*1', name: 'Mikrotik Switch', address: '10.22.87.252', protocol: 'udp', 'coa-port': '3799', 'shared-secret': 's3cret' },
  { '.id': '*5', name: 'BonusRoom Ap', address: '10.22.87.11', protocol: 'udp', 'coa-port': '3799' },
  { '.id': '*8', name: 'Brocade Switch', address: '10.22.87.254', protocol: 'udp', 'coa-port': '3799' },
];

describe('User Manager reads (#251)', () => {
  it('never passes passwords or secrets on', () => {
    const out = JSON.stringify([...pickUsers(users), ...pickRouters(routers), pickSettings({ enabled: 'true', 'paypal-password': 'x', 'web-private-password': 'y' })]);
    for (const f of SECRET_FIELDS) expect(out).not.toContain(`"${f}"`);
    expect(out).not.toMatch(/hunter2|JBSWY3DP|s3cret/);
    expect(pickUsers(users)[0]).toEqual({ '.id': '*1', name: 'f.last', group: 'Full', 'shared-users': 'unlimited', attributes: '' });
  });

  it('keeps group attributes, which are what the firewalls and switches authorise on', () => {
    const [g] = pickGroups([{ '.id': '*3', name: 'Full', 'outer-auths': 'pap,chap', attributes: 'Mikrotik-Group:full,Cisco-AVPair:shell:priv-lvl=15,PaloAlto-Admin-Role:superuser' }]);
    expect(splitAttributes(g.attributes)).toEqual([
      ['Mikrotik-Group', 'full'], ['Cisco-AVPair', 'shell:priv-lvl=15'], ['PaloAlto-Admin-Role', 'superuser'],
    ]);
  });

  it('shows every active session and the latest ended ones', () => {
    const rows = [
      { '.id': '*A', user: 'f.last', active: 'true', status: 'start', started: '2026-10-07 21:05:33', 'nas-ip-address': '10.22.87.254', 'nas-identifier': 'brocade-switch', 'calling-station-id': '10.22.87.133' },
      ...Array.from<unknown, Record<string, string>>({ length: 150 }, (_, i) => ({ '.id': `*${(i + 16).toString(16)}`, user: 'admin', active: 'false', started: `2026-10-0${1 + (i % 6)} 10:00:${String(i % 60).padStart(2, '0')}` })),
    ];
    const s = pickSessions(rows, 100);
    expect(s.active).toHaveLength(1);
    expect(s.active[0]).toMatchObject({ user: 'f.last', 'nas-identifier': 'brocade-switch' });
    expect(s.recent).toHaveLength(100);
    expect(s.recent[0].started >= s.recent[99].started).toBe(true);
  });

  it('links authenticating devices to managed ones by address', () => {
    const m = matchNasToDevices(routers, [{ id: 7, name: 'BonusRoom', addresses: ['10.22.87.11'] }]);
    expect(m.get('*5')).toEqual({ id: 7, name: 'BonusRoom' });
    expect(m.has('*1')).toBe(false);
  });

  it('only accepts RouterOS item ids', () => {
    expect(isItemId('*1A')).toBe(true);
    expect(isItemId('1')).toBe(false);
    expect(isItemId('*1;/system/reboot')).toBe(false);
  });
});
