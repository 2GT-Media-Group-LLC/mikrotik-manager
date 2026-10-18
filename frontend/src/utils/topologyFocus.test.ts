import { describe, it, expect } from 'vitest';
import { nodesWithinHops } from './topologyFocus';

// core - dist1 - access1 - ap1 ; core - dist2 ; dist1 - ext:unmanaged - access2
const edges = [
  { source: 'core', target: 'dist1' },
  { source: 'core', target: 'dist2' },
  { source: 'dist1', target: 'access1' },
  { source: 'access1', target: 'ap1' },
  { source: 'dist1', target: 'ext-1' },
  { source: 'ext-1', target: 'access2' },
  { source: 'access1', target: 'clients-access1', kind: 'client' },
  { source: 'clients-access1', target: 'client-aa', kind: 'client' },
];
const ids = (s: Set<string>) => [...s].sort();

describe('device view of the topology (#305)', () => {
  it('one hop is the device and its direct neighbours', () => {
    expect(ids(nodesWithinHops('dist1', edges, 1))).toEqual(['access1', 'clients-access1', 'client-aa', 'core', 'dist1', 'ext-1'].sort());
  });

  it('two hops go through unmanaged neighbours too', () => {
    const two = nodesWithinHops('dist1', edges, 2);
    expect(two.has('access2')).toBe(true);
    expect(two.has('ap1')).toBe(true);
    expect(two.has('dist2')).toBe(true);
  });

  it('clients never count as a hop, but come with what they hang off', () => {
    const one = nodesWithinHops('ap1', edges, 1);
    expect(one.has('access1')).toBe(true);
    expect(one.has('client-aa')).toBe(true);
    expect(one.has('dist1')).toBe(false);
  });

  it('a device with no links is shown alone', () => {
    expect(ids(nodesWithinHops('lonely', edges, 2))).toEqual(['lonely']);
  });
});
