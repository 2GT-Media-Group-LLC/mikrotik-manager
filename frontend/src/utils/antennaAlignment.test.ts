import { describe, it, expect } from 'vitest';
import { alignmentSampleFresh, appendAlignmentPoint, canAlignAntenna, initialAlignmentSelection, weakestAlignmentSignal } from './antennaAlignment';
import type { AlignmentRadio, AlignmentPeer } from '../types/antennaAlignment';

const peer = (mac: string) => ({ mac_address: mac } as AlignmentPeer);
const radio = (key: string, peers: AlignmentPeer[]) => ({ key, peers } as AlignmentRadio);
const snapshot = (radios: AlignmentRadio[]) => ({ sampled_at: '2026-10-11T01:00:00Z', radios, warnings: [] });

describe('antenna alignment selection and freshness', () => {
  it('only offers alignment for WISP radios with API access', () => {
    expect(canAlignAntenna({ device_type: 'wisp' })).toBe(true);
    expect(canAlignAntenna({ device_type: 'wisp', ssh_only: true })).toBe(false);
    for (const type of ['router', 'switch', 'wireless_ap', 'other'] as const) {
      expect(canAlignAntenna({ device_type: type })).toBe(false);
    }
  });
  it('automatically selects only an unambiguous interface and peer', () => {
    expect(initialAlignmentSelection(snapshot([radio('wireless:wlan1', [peer('A')])]), { radio: '', peer: '' }))
      .toEqual({ radio: 'wireless:wlan1', peer: 'A' });
    expect(initialAlignmentSelection(snapshot([radio('one', []), radio('two', [])]), { radio: '', peer: '' }))
      .toEqual({ radio: '', peer: '' });
    expect(initialAlignmentSelection(snapshot([radio('one', [peer('A'), peer('B')])]), { radio: '', peer: '' }))
      .toEqual({ radio: 'one', peer: '' });
  });
  it('does not switch to a different peer or interface when the chosen link disappears', () => {
    const selected = { radio: 'one', peer: 'A' };
    expect(initialAlignmentSelection(snapshot([radio('one', [peer('B')])]), selected)).toEqual(selected);
    expect(initialAlignmentSelection(snapshot([radio('two', [peer('B')])]), selected)).toEqual(selected);
  });
  it('requires fresh signals from both ends before calculating a weakest signal', () => {
    expect(weakestAlignmentSignal([-60, -66])).toBe(-66);
    expect(weakestAlignmentSignal([-60])).toBe(-60);
    expect(weakestAlignmentSignal([-60, null])).toBeNull();
    expect(weakestAlignmentSignal([NaN, -60])).toBeNull();
    expect(weakestAlignmentSignal([])).toBeNull();
  });
  it('expires sample hold after three seconds', () => {
    expect(alignmentSampleFresh(1000, 4000)).toBe(true);
    expect(alignmentSampleFresh(1000, 4001)).toBe(false);
    expect(alignmentSampleFresh(0, 1000)).toBe(false);
    expect(alignmentSampleFresh(2000, 1000)).toBe(false);
  });
  it('bounds history, keeps best for the entire session, and ignores gaps/duplicates', () => {
    let history = { points: [], best: null } as Parameters<typeof appendAlignmentPoint>[0];
    history = appendAlignmentPoint(history, { time: 1, a: -50, b: -51, weakest: -51 });
    for (let time = 2; time <= 250; time++) history = appendAlignmentPoint(history, { time, a: -60, b: -65, weakest: -65 });
    expect(history.points).toHaveLength(240);
    expect(history.best).toBe(-51);
    history = appendAlignmentPoint(history, { time: 251, a: -60, b: null, weakest: null });
    expect(history.best).toBe(-51);
    expect(appendAlignmentPoint(history, { time: 251, a: -30, b: -30, weakest: -30 })).toBe(history);
  });
});
