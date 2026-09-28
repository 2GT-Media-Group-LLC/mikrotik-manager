import { isInternalOnlyAddress, resolveAlertTarget } from '../alertTarget';

describe('alert channel targets', () => {
  it('allows LAN addresses, since ntfy and Gotify are often self-hosted', () => {
    for (const ip of ['192.168.1.20', '10.0.0.5', '172.20.3.4', 'fd00::5', '203.0.113.9']) {
      expect(isInternalOnlyAddress(ip)).toBe(false);
    }
  });

  it('refuses loopback, link-local (cloud metadata), multicast and unspecified', () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1', 'ff02::1']) {
      expect(isInternalOnlyAddress(ip)).toBe(true);
    }
  });

  it("refuses this stack's own services by name", async () => {
    for (const host of ['influxdb', 'postgres', 'redis', 'backend', 'localhost', 'x.localhost']) {
      await expect(resolveAlertTarget(host)).rejects.toThrow(/inside the manager/);
    }
  });

  it('returns an allowed IP literal unchanged', async () => {
    await expect(resolveAlertTarget('192.168.1.20')).resolves.toBe('192.168.1.20');
    await expect(resolveAlertTarget('[fd00::5]')).resolves.toBe('fd00::5');
  });
});
