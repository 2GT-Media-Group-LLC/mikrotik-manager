import { describe, it, expect } from 'vitest';
import { activeFastTrackRules } from './fastTrack';

describe('activeFastTrackRules', () => {
  it('finds an enabled FastTrack rule', () => {
    const rules = [
      { chain: 'forward', action: 'accept', 'connection-state': 'established,related' },
      { chain: 'forward', action: 'fasttrack-connection', 'connection-state': 'established,related', 'hw-offload': 'true' },
    ];
    expect(activeFastTrackRules(rules)).toHaveLength(1);
  });

  it('ignores disabled and invalid FastTrack rules', () => {
    expect(activeFastTrackRules([
      { action: 'fasttrack-connection', disabled: 'true' },
      { action: 'fasttrack-connection', invalid: 'true' },
    ])).toEqual([]);
  });

  it('ignores the dynamic counter rule RouterOS adds, and copes with no rules', () => {
    // RouterOS shows FastTrack counters as a dynamic passthrough rule.
    expect(activeFastTrackRules([{ action: 'passthrough', dynamic: 'true', comment: 'special dummy rule to show fasttrack counters' }])).toEqual([]);
    expect(activeFastTrackRules(undefined)).toEqual([]);
  });
});
