import { aggregateAPScanRows, scanSignal, scanSecurity } from '../apScan';

const vendor = () => '';

describe('AP scan parsing', () => {
  it('reads the legacy wireless package (sig, privacy) — #295', () => {
    const rows = [
      { address: 'A4:16:E7:92:06:78', ssid: 'Home', channel: '2412/20-Ce/gn', sig: '-67', privacy: 'true' },
      { address: '06:78:63:BA:E6:3C', ssid: 'Cafe', channel: '2437/20/gn', sig: '-81', privacy: 'false' },
    ];
    const out = aggregateAPScanRows([{ iface: 'wlan1', rows }], vendor);
    expect(out.map((n) => [n.ssid, n.security, n.entries[0].signal, n.entries[0].band])).toEqual([
      ['Home', 'secured', -67, '2.4 GHz'],
      ['Cafe', 'open', -81, '2.4 GHz'],
    ]);
  });

  it('reads the wifi package (signal, security)', () => {
    const rows = [{ address: 'd0:f9:9b:41:bb:88', ssid: 'Office', channel: '5180/ax/Ceee', signal: '-58', security: 'wpa2-psk,wpa3-psk' }];
    const [net] = aggregateAPScanRows([{ iface: 'wifi1', rows }], vendor);
    expect(net).toMatchObject({ ssid: 'Office', security: 'wpa2-psk,wpa3-psk' });
    expect(net.entries[0]).toMatchObject({ signal: -58, band: '5 GHz' });
  });

  it('keeps security learned from a later streamed row', () => {
    const rows: Record<string, string>[] = [
      { address: 'aa:bb:cc:00:00:01', ssid: 'Late', channel: '2412', signal: '-70' },
      { address: 'aa:bb:cc:00:00:01', ssid: 'Late', channel: '2412', signal: '-66', security: 'wpa2-psk' },
    ];
    const [net] = aggregateAPScanRows([{ iface: 'wifi1', rows }], vendor);
    expect(net.security).toBe('wpa2-psk');
    expect(net.entries).toHaveLength(1);
    expect(net.entries[0].signal).toBe(-66);
  });

  it('falls back sensibly', () => {
    expect(scanSignal({})).toBe(-100);
    expect(scanSignal({ 'signal-strength': '-61dBm' })).toBe(-61);
    expect(scanSecurity({})).toBe('open');
    expect(scanSecurity({ 'authentication-types': 'wpa2-psk' })).toBe('WPA');
  });

  it('says unknown, not open, when a legacy scan leaves out the privacy flag (#295)', () => {
    expect(scanSecurity({ address: 'aa:bb:cc:dd:ee:ff', sig: '-70' })).toBe('unknown');
    expect(scanSecurity({ address: 'aa:bb:cc:dd:ee:ff', sig: '-70', privacy: 'false' })).toBe('open');
    // The wifi package leaves security out for an open network.
    expect(scanSecurity({ address: 'aa:bb:cc:dd:ee:ff', signal: '-70' })).toBe('open');
  });
});
