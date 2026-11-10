import { parseBridgeCreate, parseBridgeUpdate, parsePriority, parseBridgeMtu, bridgeMtuProblem } from '../bridgeEdit';

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

describe('bridge MTU', () => {
  it('takes auto or a number', () => {
    expect(parseBridgeUpdate({ mtu: 'auto' })).toEqual({ fields: { mtu: 'auto' } });
    expect(parseBridgeUpdate({ mtu: 9000 })).toEqual({ fields: { mtu: '9000' } });
    expect(parseBridgeMtu(' Auto ')).toBe('auto');
    for (const bad of ['', '500', '70000', '9000.5', 'jumbo']) expect(parseBridgeUpdate({ mtu: bad })).toHaveProperty('error');
  });

  // TEST (CRS3xx, 7.25): bridge L2 MTU 1508, so 1508 set and 1600 was refused.
  const ports = [
    { name: 'sfp-sfpplus1', l2mtu: 1508 }, { name: 'sfp-sfpplus3', l2mtu: 1584 }, { name: 'ether1', l2mtu: 1508 },
    { name: 'wlan-guest', l2mtu: null },
  ];
  it('lets through what every port can carry', () => {
    expect(bridgeMtuProblem('1508', ports)).toBeNull();
    expect(bridgeMtuProblem('auto', ports)).toBeNull();
    expect(bridgeMtuProblem('9000', [])).toBeNull();
  });
  it('names the ports that are too small, and the most that fits', () => {
    const p = bridgeMtuProblem('1600', ports)!;
    expect(p).toMatch(/L2 MTU of these ports: sfp-sfpplus1 \(1508\), ether1 \(1508\), sfp-sfpplus3 \(1584\)/);
    expect(p).toMatch(/keep the bridge at 1508 or less/);
    expect(bridgeMtuProblem('1550', ports)).toMatch(/these ports: sfp-sfpplus1 \(1508\), ether1 \(1508\)\./);
    expect(bridgeMtuProblem('1550', [{ name: 'ether1', l2mtu: 1508 }])).toMatch(/its port: ether1 \(1508\).*that port\u2019s MTU/);
  });
});
