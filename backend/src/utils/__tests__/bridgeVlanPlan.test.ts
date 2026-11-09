import { planVlanWrite, frameTypesFor, planTaggedRemovals, planAccessRemovals } from '../bridgeVlanPlan';

describe('planVlanWrite', () => {
  it('adds a static row when the existing one is dynamic — the reported failure', () => {
    // /interface/bridge/vlan/set on a dynamic row answers
    // "failure: can not change dynamic" (#151).
    const w = planVlanWrite({ '.id': '*1', dynamic: 'true', untagged: 'ether2' }, 'ether3', 'untagged');
    expect(w).toEqual({ action: 'add', tagged: '', untagged: 'ether2,ether3' });
  });

  it('adds a row when the VLAN has none, instead of silently doing nothing', () => {
    expect(planVlanWrite(undefined, 'ether3', 'tagged'))
      .toEqual({ action: 'add', tagged: 'ether3', untagged: '' });
  });

  it('sets an existing static row', () => {
    const w = planVlanWrite({ '.id': '*5', dynamic: 'false', tagged: 'ether1' }, 'ether2', 'tagged');
    expect(w).toEqual({ action: 'set', id: '*5', tagged: 'ether1,ether2', untagged: '' });
  });

  it('moves a port from untagged to tagged rather than listing it twice', () => {
    const w = planVlanWrite(
      { '.id': '*5', dynamic: 'false', tagged: 'ether1', untagged: 'ether2' }, 'ether2', 'tagged'
    );
    expect(w).toEqual({ action: 'set', id: '*5', tagged: 'ether1,ether2', untagged: '' });
  });

  it('does not duplicate a port already in the right list', () => {
    const w = planVlanWrite({ '.id': '*5', dynamic: 'false', tagged: 'ether1,ether2' }, 'ether2', 'tagged');
    expect(w).toEqual({ action: 'noop' });
  });

  it('reports noop rather than writing an identical row', () => {
    // Avoids arming Change Guard for a change that alters nothing.
    expect(planVlanWrite({ '.id': '*5', dynamic: 'false', untagged: 'ether3' }, 'ether3', 'untagged'))
      .toEqual({ action: 'noop' });
  });

  it('carries the dynamic row\'s existing membership into the static one', () => {
    // The dynamic row describes what the bridge is doing right now; dropping
    // that on conversion would remove other ports from the VLAN.
    const w = planVlanWrite(
      { '.id': '*2', dynamic: 'true', tagged: 'ether1,ether9', untagged: 'ether4' },
      'ether5', 'tagged'
    );
    expect(w).toEqual({ action: 'add', tagged: 'ether1,ether9,ether5', untagged: 'ether4' });
  });

  it('tolerates spaces in RouterOS lists', () => {
    const w = planVlanWrite({ '.id': '*5', dynamic: 'false', tagged: 'ether1, ether2' }, 'ether3', 'tagged');
    expect(w).toEqual({ action: 'set', id: '*5', tagged: 'ether1,ether2,ether3', untagged: '' });
  });
});

describe('frameTypesFor', () => {
  it('admits only untagged on an access port', () => {
    expect(frameTypesFor('access')).toEqual({
      'frame-types': 'admit-only-untagged-and-priority-tagged',
      'ingress-filtering': 'yes',
    });
  });

  it('admits tagged and untagged on a trunk, untagged joining the native VLAN', () => {
    expect(frameTypesFor('trunk')).toEqual({
      'frame-types': 'admit-all',
      'ingress-filtering': 'yes',
    });
  });

  it('admits only tagged on a trunk asked to be tagged-only', () => {
    expect(frameTypesFor('trunk', true)).toEqual({
      'frame-types': 'admit-only-vlan-tagged',
      'ingress-filtering': 'yes',
    });
  });
});

describe('planTaggedRemovals (#165)', () => {
  const rows = [
    { '.id': '*1', bridge: 'bridge', 'vlan-ids': '10', tagged: 'bridge,sfp1,ether2', untagged: '' },
    { '.id': '*2', bridge: 'bridge', 'vlan-ids': '20', tagged: 'sfp1', untagged: 'ether5' },
    { '.id': '*3', bridge: 'bridge', 'vlan-ids': '30-32', tagged: 'sfp1', untagged: '' },
    { '.id': '*4', bridge: 'bridge', 'vlan-ids': '99', tagged: 'sfp1', dynamic: 'true' },
    { '.id': '*5', bridge: 'other', 'vlan-ids': '40', tagged: 'sfp1' },
  ];

  it('takes the port out of rows for unticked VLANs and keeps the rest of the row', () => {
    const p = planTaggedRemovals(rows, 'bridge', 'sfp1', [10, 30, 31, 32]);
    expect(p.writes).toEqual([{ id: '*2', tagged: '', untagged: 'ether5', vlanIds: [20] }]);
    expect(p.mixed).toEqual([]);
  });

  it('leaves the port alone where it is keeping every VLAN', () => {
    expect(planTaggedRemovals(rows, 'bridge', 'sfp1', [10, 20, 30, 31, 32]).writes).toEqual([]);
  });

  it('does not split a range row; it reports the VLANs it could not remove', () => {
    const p = planTaggedRemovals(rows, 'bridge', 'sfp1', [10, 20, 31]);
    expect(p.writes).toEqual([]);
    expect(p.mixed).toEqual([30, 32]);
  });

  it('removes a whole range row when none of it is kept', () => {
    const p = planTaggedRemovals(rows, 'bridge', 'sfp1', [10, 20]);
    expect(p.writes.map((w) => w.id)).toEqual(['*3']);
  });

  it('ignores dynamic rows, other bridges and other ports', () => {
    const p = planTaggedRemovals(rows, 'bridge', 'sfp1', []);
    expect(p.writes.map((w) => w.id)).toEqual(['*1', '*2', '*3']);
    expect(p.writes[0].tagged).toBe('bridge,ether2');
    expect(planTaggedRemovals(rows, 'bridge', 'ether9', []).writes).toEqual([]);
  });
});

describe('planAccessRemovals', () => {
  // TEST's sfp-sfpplus1 after "trunk to access" left it tagged on five VLANs.
  const rows = [
    { '.id': '*1', bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'ether1,sfp1,bridge' },
    { '.id': '*2', bridge: 'bridge', 'vlan-ids': '10', tagged: 'sfp1,sfp2', untagged: '' },
    { '.id': '*3', bridge: 'bridge', 'vlan-ids': '666', tagged: 'sfp1', untagged: 'sfp7' },
    { '.id': '*4', bridge: 'bridge', 'vlan-ids': '20', tagged: '', untagged: 'sfp1' },
    { '.id': '*5', bridge: 'bridge', 'vlan-ids': '99', tagged: 'sfp1', dynamic: 'true' },
    { '.id': '*6', bridge: 'other', 'vlan-ids': '40', tagged: 'sfp1' },
    { '.id': '*7', bridge: 'bridge', 'vlan-ids': '50', tagged: 'sfp2', untagged: '' },
  ];

  it('takes the port out of every static row but its PVID untagged', () => {
    const plan = planAccessRemovals(rows, 'bridge', 'sfp1', 1);
    expect(plan.writes).toEqual([
      { id: '*2', tagged: 'sfp2', untagged: '', vlanIds: [10] },
      { id: '*3', tagged: '', untagged: 'sfp7', vlanIds: [666] },
      { id: '*4', tagged: '', untagged: '', vlanIds: [20] },
    ]);
    expect(plan.mixed).toEqual([]);
  });

  it('keeps it untagged on the PVID, and drops it tagged there', () => {
    const plan = planAccessRemovals(rows, 'bridge', 'sfp1', 20);
    expect(plan.writes.map((w) => w.id)).toEqual(['*1', '*2', '*3']);
    expect(planAccessRemovals([{ '.id': '*9', bridge: 'bridge', 'vlan-ids': '20', tagged: 'sfp1', untagged: '' }], 'bridge', 'sfp1', 20).writes)
      .toEqual([]);
  });

  it('reports a range row that also covers the PVID rather than splitting it', () => {
    const plan = planAccessRemovals([{ '.id': '*8', bridge: 'bridge', 'vlan-ids': '5-7', tagged: 'sfp1', untagged: '' }], 'bridge', 'sfp1', 6);
    expect(plan).toEqual({ writes: [], mixed: [5, 7] });
  });
});

describe('planTaggedRemovals with a native VLAN', () => {
  // An access port on VLAN 20 made a trunk with native VLAN 1, tagged 10.
  const rows = [
    { '.id': '*1', bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,ether1' },
    { '.id': '*2', bridge: 'bridge', 'vlan-ids': '10', tagged: 'ether1', untagged: '' },
    { '.id': '*3', bridge: 'bridge', 'vlan-ids': '20', tagged: 'sfp1', untagged: 'ether1,ether2' },
    { '.id': '*4', bridge: 'bridge', 'vlan-ids': '30-31', tagged: '', untagged: 'ether1' },
  ];

  it('takes the port out of every untagged row but the native one', () => {
    const plan = planTaggedRemovals(rows, 'bridge', 'ether1', [10], 1);
    expect(plan.writes).toEqual([
      { id: '*3', tagged: 'sfp1', untagged: 'ether2', vlanIds: [20] },
      { id: '*4', tagged: '', untagged: '', vlanIds: [30, 31] },
    ]);
    expect(plan.mixed).toEqual([]);
  });

  it('takes it out of all of them for a tagged-only trunk', () => {
    const plan = planTaggedRemovals(rows, 'bridge', 'ether1', [10], null);
    expect(plan.writes.map((w) => w.id)).toEqual(['*1', '*3', '*4']);
    expect(plan.writes[0]).toEqual({ id: '*1', tagged: '', untagged: 'bridge', vlanIds: [1] });
  });

  it('reports a range row that also covers the native VLAN instead of splitting it', () => {
    const plan = planTaggedRemovals(
      [{ '.id': '*9', bridge: 'bridge', 'vlan-ids': '1-3', tagged: '', untagged: 'ether1' }],
      'bridge', 'ether1', [], 1);
    expect(plan.writes).toEqual([]);
    expect(plan.mixed).toEqual([2, 3]);
  });

  it('leaves untagged rows alone when no native VLAN is given (the old behaviour)', () => {
    const plan = planTaggedRemovals(rows, 'bridge', 'ether1', [10]);
    expect(plan.writes).toEqual([]);
  });
});
