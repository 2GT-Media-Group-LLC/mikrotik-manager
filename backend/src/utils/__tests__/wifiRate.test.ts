import { parseRateBps } from '../wifiRate';

describe('parseRateBps (#252)', () => {
  it('reads the wifi package (bare bits per second, from a wAP ax on 7.24.5)', () => {
    expect(parseRateBps('576500000')).toBe(576_500_000);
    expect(parseRateBps('720600000')).toBe(720_600_000);
  });
  it('reads the legacy driver and legacy CAPsMAN (rate first, from #250)', () => {
    expect(parseRateBps('130Mbps-20MHz/2S')).toBe(130_000_000);
    expect(parseRateBps('72.2Mbps-20MHz/1S/SGI')).toBe(72_200_000);
    expect(parseRateBps('1Mbps')).toBe(1_000_000);
    expect(parseRateBps('1.2Gbps-80MHz/2S')).toBe(1_200_000_000);
  });
  it('gives null for nothing usable', () => {
    expect(parseRateBps(undefined)).toBeNull();
    expect(parseRateBps('')).toBeNull();
    expect(parseRateBps('0')).toBeNull();
    expect(parseRateBps('n/a')).toBeNull();
  });
});
