import { parseDot1xServer, parseDot1xClient, parseRadius, newSharedSecret, withVlanAttributes, vlanFromAttributes } from '../dot1xEdit';
import { randomBytes } from 'crypto';

describe('802.1X edits (#360)', () => {
  it('turns an authenticator into RouterOS fields', () => {
    expect(parseDot1xServer({
      interface: 'ether5', auth_types: ['dot1x', 'mac-auth'], accounting: true, retrans_timeout: 10,
      server_fail_vlan_id: 30, reject_vlan_id: 99, mac_auth_mode: 'mac-as-username-and-password',
      radius_mac_format: 'xx-xx-xx-xx-xx-xx', comment: 'Desk port',
    }, true)).toEqual({ fields: {
      interface: 'ether5', 'auth-types': 'dot1x,mac-auth', accounting: 'yes', 'retrans-timeout': '10s',
      'reject-vlan-id': '99', 'server-fail-vlan-id': '30', 'mac-auth-mode': 'mac-as-username-and-password',
      'radius-mac-format': 'xx-xx-xx-xx-xx-xx', comment: 'Desk port',
    } });
  });

  it('clears a VLAN or the re-authentication time with null, and leaves out what isn\'t sent', () => {
    expect(parseDot1xServer({ guest_vlan_id: null, reauth_timeout: null }, false))
      .toEqual({ fields: { 'guest-vlan-id': '', 'reauth-timeout': '' } });
    expect(parseDot1xServer({ reauth_timeout: 3600 }, false)).toEqual({ fields: { 'reauth-timeout': '3600s' } });
  });

  it('refuses what RouterOS would', () => {
    expect(parseDot1xServer({ auth_types: ['dot1x'] }, true)).toMatchObject({ field: 'interface' });
    expect(parseDot1xServer({ interface: 'ether1', auth_types: [] }, true)).toMatchObject({ field: 'auth_types' });
    expect(parseDot1xServer({ interface: 'ether1', auth_types: ['dot1x', 'dot1x'] }, true)).toMatchObject({ field: 'auth_types' });
    expect(parseDot1xServer({ guest_vlan_id: 4095 }, false)).toMatchObject({ field: 'guest_vlan_id' });
    expect(parseDot1xServer({ retrans_timeout: 0 }, false)).toMatchObject({ field: 'retrans_timeout' });
    expect(parseDot1xServer({ interface: 'a,b' }, false)).toMatchObject({ field: 'interface' });
    expect(parseDot1xServer({}, false)).toMatchObject({ error: 'Nothing to change.' });
    // RouterOS refuses a guest VLAN with MAC authentication on.
    expect(parseDot1xServer({ interface: 'ether1', auth_types: ['dot1x', 'mac-auth'], guest_vlan_id: 30 }, true)).toMatchObject({ field: 'guest_vlan_id' });
  });

  it('checks a supplicant, and never takes an encrypted password', () => {
    expect(parseDot1xClient({ interface: 'sfp1', eap_methods: ['eap-peap'], identity: 'sw1', password: 'pw' }, true))
      .toEqual({ fields: { interface: 'sfp1', 'eap-methods': 'eap-peap', identity: 'sw1', password: 'pw' } });
    expect(parseDot1xClient({ interface: 'sfp1', eap_methods: ['eap-tls'] }, true)).toMatchObject({ field: 'client_certificate' });
    expect(parseDot1xClient({ password: 'enc:a:b:c' }, false)).toMatchObject({ field: 'password' });
  });

  it('checks a RADIUS client entry', () => {
    expect(parseRadius({ address: '10.0.0.5', service: ['dot1x'], secret: 's3cret', timeout: 1000 }, true))
      .toEqual({ fields: { address: '10.0.0.5', service: 'dot1x', secret: 's3cret', timeout: '1000ms' } });
    expect(parseRadius({ address: 'evil;/system reboot', service: ['dot1x'], secret: 'x' }, true)).toMatchObject({ field: 'address' });
    expect(parseRadius({ address: '10.0.0.5', service: ['dot1x'] }, true)).toMatchObject({ field: 'secret' });
    expect(parseRadius({ src_address: null }, false)).toEqual({ fields: { 'src-address': '' } });
  });

  it('makes shared secrets from an even alphabet', () => {
    const a = newSharedSecret(randomBytes), b = newSharedSecret(randomBytes);
    expect(a).toMatch(/^[A-Za-z2-9]{32}$/);
    expect(a).not.toBe(b);
  });

  it('puts a user in a VLAN with the tunnel attributes, keeping the rest', () => {
    const a = withVlanAttributes('Mikrotik-Group:full,Tunnel-Private-Group-ID:10', 20);
    expect(a).toBe('Mikrotik-Group:full,Tunnel-Type:13,Tunnel-Medium-Type:6,Tunnel-Private-Group-ID:20');
    expect(vlanFromAttributes(a)).toBe(20);
    expect(withVlanAttributes(a, null)).toBe('Mikrotik-Group:full');
    expect(vlanFromAttributes('Mikrotik-Group:full')).toBeNull();
  });
});

describe('User Manager users (#360)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseUmUser } = require('../userManager') as typeof import('../userManager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isSealed } = require('../sealed') as typeof import('../sealed');
  const opts = { isSealed, withVlanAttributes };

  it('adds a user in a VLAN', () => {
    expect(parseUmUser({ name: 'alice', password: 'pw', group: 'default', vlan_id: 20 }, true, opts)).toEqual({ fields: {
      name: 'alice', password: 'pw', group: 'default', attributes: 'Tunnel-Type:13,Tunnel-Medium-Type:6,Tunnel-Private-Group-ID:20',
    } });
  });

  it('keeps the password when an edit leaves it empty, and refuses bad input', () => {
    expect(parseUmUser({ password: '', comment: 'x' }, false, opts)).toEqual({ fields: { comment: 'x' } });
    expect(parseUmUser({ name: 'bob' }, true, opts)).toMatchObject({ field: 'password' });
    expect(parseUmUser({ password: 'enc:a:b:c' }, false, opts)).toMatchObject({ field: 'password' });
    expect(parseUmUser({ attributes: 'not an attribute' }, false, opts)).toMatchObject({ field: 'attributes' });
    expect(parseUmUser({ attributes: '', vlan_id: 5000 }, false, opts)).toMatchObject({ field: 'vlan_id' });
    expect(parseUmUser({ attributes: 'Mikrotik-Group:full', vlan_id: null }, false, opts)).toEqual({ fields: { attributes: 'Mikrotik-Group:full' } });
  });
});
