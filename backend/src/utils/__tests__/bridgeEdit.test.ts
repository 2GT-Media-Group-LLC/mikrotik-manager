import { parseBridgeCreate, parseBridgeUpdate, parsePriority } from '../bridgeEdit';

describe('bridge edits', () => {
  it('creates with RSTP unless told otherwise', () => {
    expect(parseBridgeCreate({ name: 'bridge-guest' })).toEqual({ fields: { name: 'bridge-guest', 'protocol-mode': 'rstp' } });
    expect(parseBridgeCreate({ name: 'br2', protocol_mode: 'none', vlan_filtering: true, comment: 'iot' }))
      .toEqual({ fields: { name: 'br2', 'protocol-mode': 'none', 'vlan-filtering': 'yes', comment: 'iot' } });
  });
  it('updates only what was sent', () => {
    expect(parseBridgeUpdate({ name: 'bridge-lan' })).toEqual({ fields: { name: 'bridge-lan' } });
    expect(parseBridgeUpdate({ priority: '0x4000', disabled: false, comment: '' }))
      .toEqual({ fields: { priority: '0x4000', disabled: 'no', comment: '' } });
    expect(parseBridgeUpdate({})).toEqual({ error: 'Nothing to change' });
  });
  it('reads STP priority as decimal or hex, in steps of 4096', () => {
    expect(parsePriority('32768')).toBe('0x8000');
    expect(parsePriority('0x1000')).toBe('0x1000');
    expect(parsePriority(0)).toBe('0x0000');
    expect(parsePriority('1000')).toBeNull();
    expect(parsePriority('0x10000')).toBeNull();
    expect(parsePriority('65536')).toBeNull();
  });
  it('refuses bad names and values', () => {
    expect(parseBridgeCreate({ name: '' })).toHaveProperty('error');
    expect(parseBridgeCreate({ name: 'a b' })).toHaveProperty('error');
    expect(parseBridgeCreate({ name: 'br;x' })).toHaveProperty('error');
    expect(parseBridgeCreate({ name: 'br', protocol_mode: 'pvst' })).toHaveProperty('error');
    expect(parseBridgeUpdate({ disabled: 'yes' })).toHaveProperty('error');
    expect(parseBridgeUpdate({ priority: 'high' })).toHaveProperty('error');
  });
});
