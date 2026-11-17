import { parseBridgeCreate, parseBridgeUpdate, parseBridgePortUpdate, parsePriority, parsePortPriority, parsePathCost, parseBridgeMtu, bridgeMtuProblem } from '../bridgeEdit';

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
  it('names the ports to raise, and the most that fits', () => {
    const p = bridgeMtuProblem('1600', ports)!;
    expect(p).toMatch(/Raise the MTU of sfp-sfpplus1 \(1508\), ether1 \(1508\), sfp-sfpplus3 \(1584\) on the Ports tab/);
    expect(p).toMatch(/Or keep the bridge at 1508 or less/);
    expect(p).toMatch(/Ports switch jumbo frames between themselves/);
  });
  it('says a port whose hardware stops short has to leave the bridge (CRS510 management port)', () => {
    const crs510 = [{ name: 'ether1', l2mtu: 2028, maxL2mtu: 2028 }, { name: 'qsfp28-1-1', l2mtu: 1584, maxL2mtu: 10218 }];
    const p = bridgeMtuProblem('9000', crs510)!;
    expect(p).toMatch(/Raise the MTU of qsfp28-1-1 \(1584\)/);
    expect(p).toMatch(/ether1 \(2028\) can't go that high .* take it out of the bridge, or keep the bridge at 2028 or less/);
    expect(bridgeMtuProblem('2028', [{ name: 'ether1', l2mtu: 2028, maxL2mtu: 2028 }])).toBeNull();
  });
});

describe('Q-in-Q and MVRP (#449)', () => {
  it('sets the bridge EtherType and MVRP', () => {
    expect(parseBridgeUpdate({ ether_type: '0x88A8', mvrp: true })).toEqual({ fields: { 'ether-type': '0x88a8', mvrp: 'yes' } });
    expect(parseBridgeUpdate({ mvrp: false })).toEqual({ fields: { mvrp: 'no' } });
    expect(parseBridgeUpdate({ ether_type: '0x0800' })).toEqual({ error: expect.stringMatching(/ether_type/) });
    expect(parseBridgeUpdate({ mvrp: 'yes' })).toEqual({ error: expect.stringMatching(/mvrp/) });
  });

  it('sets a port\'s tag stacking and MVRP states', () => {
    expect(parseBridgePortUpdate({ tag_stacking: true, mvrp_applicant_state: 'non-participant', mvrp_registrar_state: 'fixed' }))
      .toEqual({ fields: { 'tag-stacking': 'yes', 'mvrp-applicant-state': 'non-participant', 'mvrp-registrar-state': 'fixed' } });
    expect(parseBridgePortUpdate({})).toEqual({ error: 'Nothing to change' });
    expect(parseBridgePortUpdate({ tag_stacking: 'yes' })).toEqual({ error: expect.stringMatching(/tag_stacking/) });
    expect(parseBridgePortUpdate({ mvrp_registrar_state: 'forbidden' })).toEqual({ error: expect.stringMatching(/registrar/) });
    expect(parseBridgePortUpdate({ mvrp_applicant_state: 'active' })).toEqual({ error: expect.stringMatching(/applicant/) });
  });

  it('takes a port\'s spanning-tree settings', () => {
    expect(parseBridgePortUpdate({
      stp_priority: '0x40', path_cost: 2000, edge: 'no', point_to_point: 'yes',
      bpdu_guard: true, restricted_role: false, restricted_tcn: true,
    })).toEqual({ fields: {
      priority: '0x40', 'path-cost': '2000', edge: 'no', 'point-to-point': 'yes',
      'bpdu-guard': 'yes', 'restricted-role': 'no', 'restricted-tcn': 'yes',
    } });
    expect(parseBridgePortUpdate({ stp_priority: '' })).toEqual({ error: 'Nothing to change' });
    // Back to the default: unset, so RouterOS works it out again.
    expect(parseBridgePortUpdate({ path_cost: 'default' })).toEqual({ fields: { 'path-cost': '' } });
    expect(parseBridgePortUpdate({ stp_priority: 100 })).toEqual({ error: expect.stringMatching(/Port priority/) });
    expect(parseBridgePortUpdate({ path_cost: 0 })).toEqual({ error: expect.stringMatching(/Path cost/) });
    expect(parseBridgePortUpdate({ edge: 'maybe' })).toEqual({ error: expect.stringMatching(/edge/) });
    expect(parseBridgePortUpdate({ point_to_point: 'shared' })).toEqual({ error: expect.stringMatching(/point_to_point/) });
    expect(parseBridgePortUpdate({ bpdu_guard: 'yes' })).toEqual({ error: expect.stringMatching(/bpdu_guard/) });
  });

  it('reads port priority and path cost as RouterOS takes them', () => {
    expect(parsePortPriority('128')).toBe('0x80');
    expect(parsePortPriority('0xF0')).toBe('0xf0');
    expect(parsePortPriority(0)).toBe('0x00');
    expect(parsePortPriority(256)).toBeNull();
    expect(parsePortPriority(24)).toBeNull();
    expect(parsePathCost('10')).toBe('10');
    expect(parsePathCost(200_000_001)).toBeNull();
    expect(parsePathCost('1.5')).toBeNull();
  });
});
