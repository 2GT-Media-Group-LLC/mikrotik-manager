import { describe, expect, it } from 'vitest';

import {
  estimateFirewallActivity,
  firewallPacketCount,
  HIGH_VOLUME_PACKETS_PER_MINUTE,
  type FirewallCounterRule,
} from './firewallActivity';

const rule = (id: string, packets: string): FirewallCounterRule => ({
  '.id': id,
  packets,
});

describe('firewall activity', () => {
  it('estimates packets per minute', () => {
    const activity = estimateFirewallActivity(
      [rule('*1', '100')],
      [rule('*1', '500')],
      5_000
    );

    expect(activity['*1'].packetsPerMinute).toBeCloseTo(4_800);
    expect(activity['*1'].highVolume).toBe(true);
  });

  it('uses 1000 packets/min as high-volume boundary', () => {
    const activity = estimateFirewallActivity(
      [rule('*1', '0'), rule('*2', '0')],
      [
        rule('*1', String(HIGH_VOLUME_PACKETS_PER_MINUTE)),
        rule('*2', String(HIGH_VOLUME_PACKETS_PER_MINUTE - 1)),
      ],
      60_000
    );

    expect(activity['*1'].highVolume).toBe(true);
    expect(activity['*2'].highVolume).toBe(false);
  });

  it('ignores reset or invalid counters', () => {
    const activity = estimateFirewallActivity(
      [rule('*1', '500'), rule('*2', 'wat')],
      [rule('*1', '10'), rule('*2', '20')],
      5_000
    );

    expect(activity).toEqual({});
    expect(firewallPacketCount(rule('*3', 'wat'))).toBeNull();
  });

  it('reports an idle rule as zero', () => {
    const activity = estimateFirewallActivity(
      [rule('*1', '50')],
      [rule('*1', '50')],
      5_000
    );

    expect(activity['*1']).toEqual({
      packetsPerMinute: 0,
      highVolume: false,
    });
  });
});
