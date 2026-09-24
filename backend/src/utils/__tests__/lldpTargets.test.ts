import { parseDeviceTypes, LLDP_DEVICE_TYPES } from '../lldpTargets';

describe('parseDeviceTypes', () => {
  it('means every type, access points included, when omitted', () => {
    expect(parseDeviceTypes(undefined)).toEqual([...LLDP_DEVICE_TYPES]);
    expect(parseDeviceTypes('')).toContain('wireless_ap');
  });
  it('accepts a query string or an array', () => {
    expect(parseDeviceTypes('router,wireless_ap')).toEqual(['router', 'wireless_ap']);
    expect(parseDeviceTypes(['switch', 'switch'])).toEqual(['switch']);
  });
  it('rejects unknown types rather than silently targeting nothing', () => {
    expect(parseDeviceTypes('router,ap')).toBeNull();
    expect(parseDeviceTypes([])).toBeNull();
  });
});
