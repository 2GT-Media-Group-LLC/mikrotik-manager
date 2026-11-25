jest.mock('../../../utils/crypto', () => ({ decrypt: () => 'pw' }));
jest.mock('../../mikrotik/RouterOSClient');
jest.mock('../targetedReads', () => ({
  readApiConnections: jest.fn().mockResolvedValue([]),
  readCoveringRoutes: jest.fn().mockResolvedValue([]),
}));

import { RouterOSClient } from '../../mikrotik/RouterOSClient';
import { captureSnapshot } from '../pathModel';
import { auditConfig } from '../configHealth';
import type { GuardDevice } from '../ChangeGuard';

const device: GuardDevice = {
  id: 1, name: 'router', ip_address: '192.0.2.1', api_port: 8728,
  api_username: 'admin', api_password_encrypted: 'enc',
};

function installClient(version: string, vrfs: Record<string, string>[] | Error) {
  const execute = jest.fn(async (command: string): Promise<Record<string, string>[]> => {
    switch (command) {
      case '/system/resource/print': return [{ version }];
      case '/ip/address/print': return [
        { address: '10.0.0.1/24', interface: 'ether1' },
        { address: '10.0.0.1/24', interface: 'ether2' },
        { address: '10.0.0.1/24', interface: 'ether3' },
        { address: '10.0.0.1/24', interface: 'ether4' },
        { address: '10.0.0.1/24', interface: 'ether5' },
      ];
      case '/interface/list/print': return [{ name: 'red-list' }];
      case '/interface/list/member/print': return [{ list: 'red-list', interface: 'ether2' }];
      case '/ip/vrf/print':
      case '/ip/route/vrf/print':
        if (vrfs instanceof Error) throw vrfs;
        return vrfs;
      default: return [];
    }
  });
  const disconnect = jest.fn();
  jest.mocked(RouterOSClient).mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined), disconnect, execute,
  }) as unknown as RouterOSClient);
  return { execute, disconnect };
}

describe('snapshot VRF collection for config health', () => {
  it('uses RouterOS 6 routing marks and interface lists to separate duplicate addresses', async () => {
    const client = installClient('6.49.10 (long-term)', [
      { 'routing-mark': 'red', interfaces: 'ether1,red-list' },
      { 'routing-mark': 'blue', interfaces: 'ether3' },
    ]);
    const snap = await captureSnapshot(device);
    const findings = auditConfig(snap, device).filter((f) => f.rule === 'duplicate-address');
    expect(client.execute).toHaveBeenCalledWith('/ip/route/vrf/print', { detail: '' });
    expect(client.execute).not.toHaveBeenCalledWith('/ip/vrf/print', { detail: '' });
    expect(client.disconnect).toHaveBeenCalled();
    expect(snap.vrfsRead).toBe(false);
    expect(findings.map((f) => [f.fingerprint, f.objects])).toEqual([
      ['duplicate-address:10.0.0.1:vrf:red', ['10.0.0.1', 'ether1', 'ether2']],
      ['duplicate-address:10.0.0.1', ['10.0.0.1', 'ether4', 'ether5']],
    ]);
  });

  it('uses the RouterOS 7 VRF menu as before', async () => {
    const client = installClient('7.24.5 (stable)', [
      { name: 'red', interfaces: 'ether1,red-list' },
      { name: 'blue', interfaces: 'ether3' },
    ]);
    const snap = await captureSnapshot(device);
    expect(client.execute).toHaveBeenCalledWith('/ip/vrf/print', { detail: '' });
    expect(client.execute).not.toHaveBeenCalledWith('/ip/route/vrf/print', { detail: '' });
    expect(snap.vrfsRead).toBe(true);
    expect(auditConfig(snap, device).filter((f) => f.rule === 'duplicate-address').map((f) => f.fingerprint))
      .toEqual(['duplicate-address:10.0.0.1:vrf:red', 'duplicate-address:10.0.0.1']);
  });

  it('checks main when the RouterOS 6 VRF table is empty', async () => {
    installClient('6.49.10', []);
    const snap = await captureSnapshot(device);
    expect(auditConfig(snap, device).filter((f) => f.rule === 'duplicate-address')).toEqual([
      expect.objectContaining({ fingerprint: 'duplicate-address:10.0.0.1' }),
    ]);
  });

  it('reports uncertainty when the RouterOS 6 VRF table cannot be read', async () => {
    installClient('6.49.10', new Error('not permitted'));
    const snap = await captureSnapshot(device);
    expect(auditConfig(snap, device).filter((f) => f.rule.startsWith('duplicate-address'))).toEqual([
      expect.objectContaining({ rule: 'duplicate-address-vrf-unconfirmed', severity: 'info' }),
    ]);
  });
});
