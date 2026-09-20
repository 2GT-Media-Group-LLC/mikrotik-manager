import { describe, it, expect } from 'vitest';
import { classifyPort, portBasis, portSortKey } from './portClass';

/**
 * Port names below are the real `default-name` values read from the four
 * devices on the reference fleet: a CRS510-8XS-2XQ, a CCR2216-1G-12XS-2XQ, a
 * CRS309-1G-8S+ and a wAP ax.
 */
describe('classifyPort', () => {
  it('recognises copper', () => {
    expect(classifyPort({ name: 'ether1' })).toMatchObject({ kind: 'copper', label: '1' });
  });

  it('recognises every SFP spelling the fleet actually uses', () => {
    for (const n of ['sfp-sfpplus1', 'sfp28-5', 'sfp1', 'sfpplus2']) {
      expect(classifyPort({ name: n }).kind).toBe('sfp');
    }
  });

  it('recognises a QSFP breakout lane and its cage', () => {
    expect(classifyPort({ name: 'qsfp28-1-3' })).toMatchObject({
      kind: 'qsfp-lane', cageKey: 'qsfp28-1', lane: 3, label: '1/3',
    });
  });

  it('recognises a whole QSFP cage', () => {
    expect(classifyPort({ name: 'qsfp28-2' })).toMatchObject({ kind: 'qsfp', label: 'Q2' });
  });

  it('classifies bridges, bonds and VLANs by type, not name', () => {
    // A bridge called "ether-core" is still a bridge.
    expect(classifyPort({ name: 'ether-core', type: 'bridge' }).kind).toBe('virtual');
    expect(classifyPort({ name: 'bond1', type: 'bond' }).kind).toBe('virtual');
    expect(classifyPort({ name: 'mgmt', type: 'vlan' }).kind).toBe('virtual');
  });
});

/**
 * The reported bug (#146), reproduced on hardware: renaming sfp-sfpplus8 gave
 * name=starlink1 with default-name=sfp-sfpplus8 intact.
 */
describe('renamed ports', () => {
  it('keeps a renamed SFP port in the SFP group', () => {
    const renamed = { name: 'starlink1', default_name: 'sfp-sfpplus8', type: 'ether' };
    // Label is P8, not S8: sfp-sfpplus ports have always been labelled P on
    // the faceplate, and that is preserved deliberately.
    expect(classifyPort(renamed)).toMatchObject({ kind: 'sfp', label: 'P8' });
  });

  it('keeps a renamed copper port copper', () => {
    expect(classifyPort({ name: 'uplink', default_name: 'ether5', type: 'ether' }))
      .toMatchObject({ kind: 'copper', label: '5' });
  });

  it('keeps a renamed QSFP lane in its cage', () => {
    expect(classifyPort({ name: 'spine-a', default_name: 'qsfp28-2-1', type: 'ether' }))
      .toMatchObject({ kind: 'qsfp-lane', cageKey: 'qsfp28-2', lane: 1 });
  });

  it('is what the old rule got wrong', () => {
    // The old test was `name.startsWith('ether')`, with everything else counted
    // as SFP. That put a renamed copper port in the SFP group.
    const renamedCopper = { name: 'starlink1', default_name: 'ether5', type: 'ether' };
    expect(renamedCopper.name.startsWith('ether')).toBe(false);
    expect(classifyPort(renamedCopper).kind).toBe('copper');
  });
});

describe('portBasis', () => {
  it('prefers the factory name', () => {
    expect(portBasis({ name: 'starlink1', default_name: 'sfp-sfpplus8' })).toBe('sfp-sfpplus8');
  });

  it('falls back to the display name, which is the pre-upgrade behaviour', () => {
    // Rows collected before default_name existed must classify as they did
    // before, not scatter for one poll cycle.
    expect(portBasis({ name: 'ether3' })).toBe('ether3');
    expect(portBasis({ name: 'ether3', default_name: null })).toBe('ether3');
    expect(portBasis({ name: 'ether3', default_name: '' })).toBe('ether3');
  });
});

describe('portSortKey', () => {
  it('orders copper before SFP before QSFP', () => {
    const ports = [
      { name: 'qsfp28-1-1' }, { name: 'sfp28-3' }, { name: 'ether1' }, { name: 'sfp28-1' },
    ];
    const sorted = [...ports].sort((a, b) => {
      const ka = portSortKey(a), kb = portSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
    });
    expect(sorted.map((p) => p.name)).toEqual(['ether1', 'sfp28-1', 'sfp28-3', 'qsfp28-1-1']);
  });

  it('sorts numerically, so port 10 follows port 9', () => {
    const ka = portSortKey({ name: 'ether9' });
    const kb = portSortKey({ name: 'ether10' });
    expect(ka[1]).toBeLessThan(kb[1]);
  });

  it('sorts a renamed port by its hardware position, not its new name', () => {
    const renamed = { name: 'aaa-first', default_name: 'ether9', type: 'ether' };
    expect(portSortKey(renamed)[1]).toBe(9);
  });
});
