import { describe, it, expect } from 'vitest';
import { buildClientConf } from './wireguardClientConf';

describe('buildClientConf', () => {
  it('builds the minimal [Interface]/[Peer] blocks', () => {
    expect(buildClientConf({
      privateKey: 'clientpriv=',
      address: '192.0.2.11/32',
      serverPublicKey: 'serverpub=',
    })).toBe(
      '[Interface]\n' +
      'PrivateKey = clientpriv=\n' +
      'Address = 192.0.2.11/32\n' +
      '\n' +
      '[Peer]\n' +
      'PublicKey = serverpub=\n' +
      'AllowedIPs = 0.0.0.0/0, ::/0',
    );
  });

  it('adds DNS, Endpoint and PersistentKeepalive only when given', () => {
    const conf = buildClientConf({
      privateKey: 'clientpriv=',
      address: '192.0.2.11/32, fc00:0:0:2::b/128',
      dns: '192.0.2.1',
      serverPublicKey: 'serverpub=',
      endpoint: 'vpn.example.com:44219',
      allowedIps: '192.0.2.0/24',
      keepaliveSeconds: '30',
    });
    expect(conf).toContain('DNS = 192.0.2.1');
    expect(conf).toContain('Endpoint = vpn.example.com:44219');
    expect(conf).toContain('AllowedIPs = 192.0.2.0/24');
    expect(conf).toContain('PersistentKeepalive = 30');
  });

  it('falls back to a full tunnel when no AllowedIPs is given, matching the fleet’s existing peers', () => {
    expect(buildClientConf({ privateKey: 'p=', address: 'a', serverPublicKey: 's=' })).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
  });
});
