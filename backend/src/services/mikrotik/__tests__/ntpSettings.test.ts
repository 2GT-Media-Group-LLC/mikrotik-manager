import { planNtpWrites, legacyServerList } from '../ntpSettings';

// State as RouterOS 6.49 without the ntp package reports it (read from a CHR).
const v6 = {
  server: {},
  client: { enabled: 'no', 'primary-ntp': '0.0.0.0', 'secondary-ntp': '0.0.0.0', 'server-dns-names': '', mode: 'broadcast' },
};
const v7 = {
  server: { enabled: 'no', broadcast: 'no', manycast: 'no' },
  client: { enabled: 'yes', mode: 'unicast', servers: 'pool.ntp.org' },
};
// What the page sends: every field, every time.
const page = { server_enabled: false, server_broadcast: false, server_manycast: false };

describe('NTP writes (#180)', () => {
  it("saves the client on RouterOS 6 without touching the server it doesn't have", () => {
    const w = planNtpWrites({ ...page, client_enabled: true, client_mode: 'unicast', client_servers: '162.159.200.1, time.cloudflare.com' }, v6);
    expect(w.server).toBeNull();
    expect(w.client).toEqual({
      enabled: 'yes',
      'primary-ntp': '162.159.200.1', 'secondary-ntp': '0.0.0.0', 'server-dns-names': 'time.cloudflare.com',
    });
  });

  it('refuses to turn on a server RouterOS 6 lacks, and v7-only client modes', () => {
    expect(() => planNtpWrites({ ...page, server_enabled: true }, v6)).toThrow(/ntp package/);
    expect(() => planNtpWrites({ client_mode: 'manycast' }, v6)).toThrow(/unicast and broadcast/);
  });

  it('on RouterOS 7 sends only what changed', () => {
    expect(planNtpWrites({ ...page, client_enabled: true, client_mode: 'unicast', client_servers: 'pool.ntp.org' }, v7))
      .toEqual({ server: null, client: null });
    expect(planNtpWrites({ ...page, server_enabled: true, client_servers: 'pool.ntp.org, time.cloudflare.com' }, v7))
      .toEqual({ server: { enabled: 'yes' }, client: { servers: 'pool.ntp.org,time.cloudflare.com' } });
  });

  it("shows RouterOS 6's servers as one list", () => {
    expect(legacyServerList({ 'primary-ntp': '1.2.3.4', 'secondary-ntp': '0.0.0.0', 'server-dns-names': 'a.example,b.example' }))
      .toBe('1.2.3.4,a.example,b.example');
  });
});
