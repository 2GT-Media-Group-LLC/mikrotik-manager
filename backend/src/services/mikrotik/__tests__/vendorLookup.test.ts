jest.mock('../../../utils/crypto', () => ({ decrypt: (s: string) => s }));
jest.mock('../RouterOSClient');
jest.mock('../../../config/database');
jest.mock('../../../config/influxdb');
jest.mock('../../../utils/oui');

import { DeviceCollector, DeviceRow } from '../DeviceCollector';
import { query } from '../../../config/database';
import { lookupVendor, ouiLoaded } from '../../../utils/oui';

// jump_host_id is for `dev`, whose collector won't start without a route;
// asserted rather than annotated so it compiles here too, where there's none.
const device = {
  id: 1, name: 'test-router', ip_address: '192.0.2.1', api_port: 8728,
  api_username: 'admin', api_password_encrypted: 'x', jump_host_id: null, device_type: 'router', status: 'online',
} as DeviceRow;
const lookup = (c: DeviceCollector) => (c as unknown as { lookupMissingVendors(): Promise<void> }).lookupMissingVendors();

describe('client vendor lookup', () => {
  beforeEach(() => { (query as jest.Mock).mockReset(); (query as jest.Mock).mockResolvedValue([]); });

  it('waits until the vendor list has loaded', async () => {
    (ouiLoaded as jest.Mock).mockReturnValue(false);
    await lookup(new DeviceCollector(device));
    // Every answer would be '', stored as "not in the list" for good.
    expect(query).not.toHaveBeenCalled();
  });

  it('looks up only clients never looked up, so an unknown MAC is not rewritten every poll', async () => {
    (ouiLoaded as jest.Mock).mockReturnValue(true);
    (lookupVendor as jest.Mock).mockReturnValue(''); // a randomised MAC: in no list
    (query as jest.Mock).mockImplementation(async (sql: string) =>
      sql.includes('vendor IS NULL') ? [{ mac_address: '3a:00:00:00:00:01' }] : []);
    await lookup(new DeviceCollector(device));
    const [[select], [, update]] = (query as jest.Mock).mock.calls;
    // '' is "looked up, not found": not selected again.
    expect(select).not.toContain("vendor = ''");
    expect(select).toMatch(/vendor IS NULL AND active = TRUE\s+LIMIT 200/);
    expect(update).toEqual(['', 1, '3a:00:00:00:00:01']);
  });
});
