import type { Request } from 'express';
import { deviceIdFromPath, deviceIdFromQuery } from '../deviceLock';

const req = (path: string, extra: Partial<Request> = {}): Request =>
  ({ path, query: {}, body: {}, ...extra }) as unknown as Request;

describe('deviceIdFromPath', () => {
  it('locks writes that change the device', () => {
    for (const p of ['/8/firewall', '/8/firewall/*4', '/8/interfaces/ether1', '/8/bonds/bond1',
      '/8/vlans/copy', '/8/reboot', '/8/install-update', '/8/ssh-key', '/8/system-config', '/8/queues/*1']) {
      expect(deviceIdFromPath(req(p))).toBe(8);
    }
  });

  it('leaves reads and manager-only records unlocked', () => {
    for (const p of ['/8', '/8/location', '/8/monitoring', '/8/preflight', '/8/sync', '/8/test',
      '/8/check-update', '/8/config-health/scan', '/8/change-guard/check', '/8/ssh-key/verify',
      '/8/tools/ping', '/8/spectral-scan/wlan1', '/8/lte/data-cap/lte1/send']) {
      expect(deviceIdFromPath(req(p))).toBeNull();
    }
  });

  it('ignores routes that are not about one device', () => {
    expect(deviceIdFromPath(req('/ssh-keys/deploy-all'))).toBeNull();
    expect(deviceIdFromPath(req('/bulk-add/jobs'))).toBeNull();
    expect(deviceIdFromPath(req('/ssid/bulk'))).toBeNull();
  });
});

describe('deviceIdFromQuery', () => {
  it('reads ?deviceId= or body.deviceId', () => {
    expect(deviceIdFromQuery(req('/wireguard', { query: { deviceId: '5' } as never }))).toBe(5);
    expect(deviceIdFromQuery(req('/setup', { body: { deviceId: 7 } }))).toBe(7);
    expect(deviceIdFromQuery(req('/snmp', { body: { device_ids: [1, 2] } }))).toBeNull();
  });
});
