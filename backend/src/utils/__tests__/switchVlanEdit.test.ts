import { switchVlanEntry, switchPortVlan } from '../switchVlanEdit';

describe('switchVlanEntry', () => {
  it('builds a new entry', () => {
    expect(switchVlanEntry({ switch: 'switch1', vlan_id: 20, ports: ['ether2', 'switch1-cpu', 'ether2'] }, true))
      .toEqual({ fields: { switch: 'switch1', 'vlan-id': '20', ports: 'ether2,switch1-cpu' } });
  });
  it('needs a switch, a VLAN and a port to add', () => {
    expect(switchVlanEntry({ vlan_id: 20, ports: ['ether2'] }, true)).toHaveProperty('error');
    expect(switchVlanEntry({ switch: 'switch1', vlan_id: 4096, ports: ['ether2'] }, true)).toHaveProperty('error');
    expect(switchVlanEntry({ switch: 'switch1', vlan_id: 20, ports: [] }, true)).toHaveProperty('error');
  });
  it('changes only what was sent', () => {
    expect(switchVlanEntry({ disabled: false }, false)).toEqual({ fields: { disabled: 'no' } });
    expect(switchVlanEntry({ ports: ['ether3'], independent_learning: true }, false))
      .toEqual({ fields: { ports: 'ether3', 'independent-learning': 'yes' } });
    expect(switchVlanEntry({}, false)).toEqual({ error: 'Nothing to change' });
  });
  it('refuses bad port names and types', () => {
    expect(switchVlanEntry({ ports: ['ether2;/system reset'] }, false)).toHaveProperty('error');
    expect(switchVlanEntry({ ports: ['ether\\2'] }, false)).toHaveProperty('error');
    expect(switchVlanEntry({ ports: ['ether2,ether3'] }, false)).toHaveProperty('error');
    expect(switchVlanEntry({ ports: 'ether2' }, false)).toHaveProperty('error');
    expect(switchVlanEntry({ disabled: 'yes' }, false)).toHaveProperty('error');
  });
});

describe('switchPortVlan', () => {
  it('maps mode, header and default VLAN', () => {
    expect(switchPortVlan({ vlan_mode: 'secure', vlan_header: 'always-strip', default_vlan_id: 11 }))
      .toEqual({ fields: { 'vlan-mode': 'secure', 'vlan-header': 'always-strip', 'default-vlan-id': '11' } });
    expect(switchPortVlan({ default_vlan_id: 'auto' })).toEqual({ fields: { 'default-vlan-id': 'auto' } });
  });
  it('refuses values RouterOS does not have', () => {
    expect(switchPortVlan({ vlan_mode: 'strict' })).toHaveProperty('error');
    expect(switchPortVlan({ vlan_header: 'strip' })).toHaveProperty('error');
    expect(switchPortVlan({ default_vlan_id: 5000 })).toHaveProperty('error');
    expect(switchPortVlan({})).toEqual({ error: 'Nothing to change' });
  });
});
