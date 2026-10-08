import { describe, it, expect } from 'vitest';
import { formatRate, formatRatePair } from './wifiRate';

describe('formatRate (#252)', () => {
  it('formats bits per second for people', () => {
    expect(formatRate(576_500_000)).toBe('577 Mbps');
    expect(formatRate('72200000')).toBe('72.2 Mbps');
    expect(formatRate(1_200_000_000)).toBe('1.2 Gbps');
    expect(formatRate(null)).toBeNull();
    expect(formatRate(0)).toBeNull();
  });
  it('pairs TX and RX', () => {
    expect(formatRatePair(576_500_000, 720_600_000)).toBe('TX 577 Mbps / RX 721 Mbps');
    expect(formatRatePair(1_000_000, null)).toBe('TX 1 Mbps / RX —');
    expect(formatRatePair(null, null)).toBeNull();
  });
});
