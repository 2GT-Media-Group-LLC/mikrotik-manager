import { describe, it, expect } from 'vitest';
import { formatBitRate, formatPacketRate, trafficFormat } from './trafficUnits';

describe('traffic as rates', () => {
  it('labels bits and packets per second in decimal units, as links are rated', () => {
    expect(formatBitRate(950)).toBe('950 bps');
    expect(formatBitRate(12_400)).toBe('12.4 Kbps');
    expect(formatBitRate(150_000_000)).toBe('150 Mbps');
    expect(formatBitRate(1_234_000_000)).toBe('1.2 Gbps');
    expect(formatBitRate(0)).toBe('0 bps');
    expect(formatPacketRate(150_000)).toBe('150 Kpps');
    expect(formatPacketRate(2_100_000)).toBe('2.1 Mpps');
  });

  it("turns a point's bytes and packets into rates over the seconds it covers", () => {
    const f = trafficFormat('rate', String);
    // 4.2 GB in a 15-minute point is about 37 Mbps; 2.8 million packets about 3.1 Kpps.
    expect(formatBitRate(f.bytes(4.2e9, 900))).toBe('37.3 Mbps');
    expect(formatPacketRate(f.packets(2.8e6, 900))).toBe('3.1 Kpps');
    // The newest point, five minutes into its window, isn't divided by the whole window.
    expect(f.bytes(1.5e9, 300)).toBe(40e6);
  });

  it('leaves volume as it was', () => {
    const f = trafficFormat('volume', (n) => `${n}`);
    expect(f.rate).toBe(false);
    expect(f.bytes(4.2e9, 900)).toBe(4.2e9);
    expect(f.packetsLabel(28)).toBe('28 pkts');
  });
});
