import { describe, it, expect } from 'vitest';
import { unmutedForApiSslNotice, PLAIN_API_CHECK } from './apiSslNotice';

const devices = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe('API-SSL notice mutes (#194)', () => {
  it('shows every device when nothing is muted', () => {
    expect(unmutedForApiSslNotice(devices, [])).toEqual({ mutedFleetWide: false, devices });
  });
  it('hides the notice when the check is muted fleet-wide', () => {
    expect(unmutedForApiSslNotice(devices, [{ check_id: PLAIN_API_CHECK, device_id: null }])).toEqual({ mutedFleetWide: true, devices: [] });
  });
  it('leaves out devices muted on their own, and ignores other checks', () => {
    const r = unmutedForApiSslNotice(devices, [
      { check_id: PLAIN_API_CHECK, device_id: 2 },
      { check_id: 'service-telnet', device_id: null },
    ]);
    expect(r.mutedFleetWide).toBe(false);
    expect(r.devices.map((d) => d.id)).toEqual([1, 3]);
  });
});
