import { describe, it, expect } from 'vitest';
import { portVlanMode } from './portVlanMode';
import type { BridgeVlanEntry } from '../types';

const port = (over: Partial<BridgeVlanEntry>): BridgeVlanEntry => ({ device_id: 8, bridge: 'bridge', port: 'sfp-sfpplus1', tagged: false, ...over });

describe('portVlanMode', () => {
  it('reads access from frame admission, even with tagged VLANs left over', () => {
    // TEST's sfp-sfpplus1 after the old access save: still tagged on five VLANs.
    expect(portVlanMode(port({ pvid: 1, tagged: true, config_json: { 'frame-types': 'admit-only-untagged-and-priority-tagged' } }))).toBe('access');
  });
  it('reads trunk from frame admission', () => {
    expect(portVlanMode(port({ pvid: 1, tagged: false, config_json: { 'frame-types': 'admit-only-vlan-tagged' } }))).toBe('trunk');
  });
  it('falls back to membership when every frame is admitted', () => {
    expect(portVlanMode(port({ tagged: true, config_json: { 'frame-types': 'admit-all' } }))).toBe('trunk');
    expect(portVlanMode(port({ pvid: 20, config_json: { 'frame-types': 'admit-all' } }))).toBe('access');
    expect(portVlanMode(port({ pvid: 1 }))).toBe('none');
    expect(portVlanMode(null)).toBe('none');
  });
});
