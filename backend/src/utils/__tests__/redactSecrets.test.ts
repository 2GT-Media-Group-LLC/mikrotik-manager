import { maskSecrets, canSeeDeviceSecrets, SECRET_MASK } from '../redactSecrets';

describe('maskSecrets', () => {
  it('masks Wi-Fi, WireGuard, SNMP and hotspot secrets at any depth', () => {
    const out = maskSecrets({
      profiles: [{ name: 'home', passphrase: 'hunter22', 'wpa2-pre-shared-key': 'x1' }],
      wireguard: { interfaces: [{ name: 'wg0', 'private-key': 'abc=', 'public-key': 'pub=' }], peers: [{ 'preshared-key': 'psk=' }] },
      snmp: { community_name: 'n0t-public', version: 'v2c' },
      users: [{ name: 'guest1', password: 'p' }],
      iface: { config_json: { 'security.passphrase': 'inner' } },
    });
    expect(out.profiles[0].passphrase).toBe(SECRET_MASK);
    expect(out.profiles[0]['wpa2-pre-shared-key']).toBe(SECRET_MASK);
    expect(out.profiles[0].name).toBe('home');
    expect(out.wireguard.interfaces[0]['private-key']).toBe(SECRET_MASK);
    expect(out.wireguard.interfaces[0]['public-key']).toBe('pub=');
    expect(out.wireguard.peers[0]['preshared-key']).toBe(SECRET_MASK);
    expect(out.snmp.community_name).toBe(SECRET_MASK);
    expect(out.snmp.version).toBe('v2c');
    expect(out.users[0].password).toBe(SECRET_MASK);
    expect(out.iface.config_json['security.passphrase']).toBe(SECRET_MASK);
  });

  it('leaves empty values and yes/no flags alone', () => {
    // An empty passphrase means an open network, and /certificate reports
    // private-key=true meaning a key exists; neither is a secret.
    const out = maskSecrets([{ passphrase: '' }, { 'private-key': 'true' }]);
    expect(out).toEqual([{ passphrase: '' }, { 'private-key': 'true' }]);
  });

  it('does not change the original', () => {
    const src = { passphrase: 'x' };
    maskSecrets(src);
    expect(src.passphrase).toBe('x');
  });

  it('lets only operators and admins see secrets', () => {
    expect(canSeeDeviceSecrets({ role: 'admin' })).toBe(true);
    expect(canSeeDeviceSecrets({ role: 'operator' })).toBe(true);
    expect(canSeeDeviceSecrets({ role: 'viewer' })).toBe(false);
    expect(canSeeDeviceSecrets(undefined)).toBe(false);
  });
});
