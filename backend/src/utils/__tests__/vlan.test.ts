import { expandVlanIds, isMultiVlanSpec, aggregateBridgeVlans, portVlanMembership } from '../vlan';

describe('expandVlanIds', () => {
  it('handles a single id, a list, and a range', () => {
    expect(expandVlanIds('10')).toEqual([10]);
    expect(expandVlanIds('10,20,30')).toEqual([10, 20, 30]);
    expect(expandVlanIds('10-12')).toEqual([10, 11, 12]);
    expect(expandVlanIds('1,10-12,20')).toEqual([1, 10, 11, 12, 20]);
  });

  it('ignores empty and malformed specs rather than inventing VLAN 0', () => {
    expect(expandVlanIds(undefined)).toEqual([]);
    expect(expandVlanIds('')).toEqual([]);
    expect(expandVlanIds('abc')).toEqual([]);
    expect(expandVlanIds('20-10')).toEqual([]);   // inverted range
  });

  it('identifies multi-VLAN specs', () => {
    expect(isMultiVlanSpec('10')).toBe(false);
    expect(isMultiVlanSpec('')).toBe(false);
    expect(isMultiVlanSpec('10-20')).toBe(true);
    expect(isMultiVlanSpec('10,20')).toBe(true);
  });
});

describe('aggregateBridgeVlans', () => {
  it('expands a range into one entry per VLAN, keeping the source spec', () => {
    const out = aggregateBridgeVlans([
      { bridge: 'bridge', 'vlan-ids': '10-12', tagged: 'sfp1', untagged: '', dynamic: 'false' },
    ]);
    expect(out.map((v) => v.vlanId)).toEqual([10, 11, 12]);
    expect(out.every((v) => v.spec === '10-12')).toBe(true);
    expect(out.every((v) => v.tagged.length === 1 && v.tagged[0] === 'sfp1')).toBe(true);
  });

  it('keeps the same VLAN ID on two bridges apart', () => {
    const out = aggregateBridgeVlans([
      { bridge: 'bridge1', 'vlan-ids': '1', tagged: '', untagged: 'ether1', dynamic: 'false' },
      { bridge: 'bridge2', 'vlan-ids': '1', tagged: '', untagged: 'ether5', dynamic: 'false' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((v) => v.bridge === 'bridge1')?.untagged).toEqual(['ether1']);
    expect(out.find((v) => v.bridge === 'bridge2')?.untagged).toEqual(['ether5']);
  });

  /**
   * The regression that broke VLAN editing: a dynamic row created by a port PVID
   * sits alongside the operator's row for the same VLAN. Because updateBridgeVlan is
   * remove-then-add, anything reported here is written back — so a dynamic port must
   * never appear in the membership, or every save bakes it into the configuration.
   */
  it('excludes dynamic rows from membership but still lists the VLAN', () => {
    const out = aggregateBridgeVlans([
      { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge', dynamic: 'true',
        comment: 'added by pvid', 'current-untagged': 'bridge' },
      { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'sfp28-2', dynamic: 'false' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].untagged).toEqual(['sfp28-2']);   // not ['bridge', 'sfp28-2']
    expect(out[0].rows).toHaveLength(2);            // both kept for config_json
  });

  it('lists a VLAN that exists only dynamically, with no editable membership', () => {
    const out = aggregateBridgeVlans([
      { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge', dynamic: 'true' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].vlanId).toBe(1);
    expect(out[0].untagged).toEqual([]);
    expect(out[0].spec).toBe('');
  });

  it('unions two static rows for one VLAN instead of letting the last one win', () => {
    const out = aggregateBridgeVlans([
      { bridge: 'bridge', 'vlan-ids': '20', tagged: 'sfp1', untagged: '', dynamic: 'false' },
      { bridge: 'bridge', 'vlan-ids': '20', tagged: 'sfp2', untagged: '', dynamic: 'false' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tagged.sort()).toEqual(['sfp1', 'sfp2']);
  });

  it('takes the name from a static row, never from a dynamic one', () => {
    const out = aggregateBridgeVlans([
      { bridge: 'bridge', 'vlan-ids': '1', untagged: 'bridge', dynamic: 'true', comment: 'added by pvid' },
      { bridge: 'bridge', 'vlan-ids': '1', untagged: 'sfp28-2', dynamic: 'false', comment: 'Management' },
    ]);
    expect(out[0].name).toBe('Management');
  });
});

describe('portVlanMembership', () => {
  it('maps each port to the VLANs it is statically tagged and untagged in', () => {
    const m = portVlanMembership([
      { bridge: 'bridge', 'vlan-ids': '10,20', tagged: 'sfp1', untagged: 'ether1', dynamic: 'false' },
      { bridge: 'bridge', 'vlan-ids': '30', tagged: 'sfp1', untagged: '', dynamic: 'false' },
    ]);
    expect(m.get('sfp1')).toEqual({ tagged: [10, 20, 30], untagged: [] });
    expect(m.get('ether1')).toEqual({ tagged: [], untagged: [10, 20] });
  });

  it('ignores dynamic rows so the port editor does not write them back', () => {
    const m = portVlanMembership([
      { bridge: 'bridge', 'vlan-ids': '1', untagged: 'bridge,ether1', dynamic: 'true' },
    ]);
    expect(m.size).toBe(0);
  });
});
