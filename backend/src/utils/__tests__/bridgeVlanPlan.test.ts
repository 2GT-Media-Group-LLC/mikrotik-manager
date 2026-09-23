import { planVlanWrite, frameTypesFor } from '../bridgeVlanPlan';

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

  it('admits only tagged on a trunk', () => {
    expect(frameTypesFor('trunk')).toEqual({
      'frame-types': 'admit-only-vlan-tagged',
      'ingress-filtering': 'yes',
    });
  });
});
