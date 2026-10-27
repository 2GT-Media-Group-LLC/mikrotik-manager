import { aggregateAPScanRows, mergeScanRows, scanSignal, scanSecurity, legacyScanScript, parseLegacyScanOutput } from '../apScan';

const vendor = () => '';

describe('AP scan parsing', () => {
  it('reads the legacy wireless package (sig, privacy) — #295', () => {
    const rows: Record<string, string>[] = [
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

describe('streamed scan updates (#295)', () => {
  it('a privacy flag that arrives in a later update without the address is kept', () => {
    // As ronchan44's router reports it: `privacy=true` in `as-value`, but the
    // streamed update carrying it names the row by .id only.
    const rows: Record<string, string>[] = [
      { '.id': '*1', address: 'A4:16:E7:92:06:78', ssid: 'Neighbour', channel: '2412/20-Ce/gn', sig: '-83' },
      { '.id': '*2', address: 'D0:F9:9B:45:A4:5A', ssid: 'Cafe', channel: '2412/20-Ce/gn', sig: '-80' },
      { '.id': '*1', privacy: 'true', sig: '-81' },
      { '.id': '*2', privacy: 'false' },
    ];
    const nets = aggregateAPScanRows([{ iface: 'wlan1', rows }], () => '');
    expect(nets.find((n) => n.ssid === 'Neighbour')?.security).toBe('secured');
    expect(nets.find((n) => n.ssid === 'Cafe')?.security).toBe('open');
    expect(nets.find((n) => n.ssid === 'Neighbour')?.entries[0].signal).toBe(-81);
  });

  it('merges by .id, later values winning, and drops rows marked dead', () => {
    const merged = mergeScanRows([
      { '.id': '*1', address: 'aa', sig: '-70' },
      { '.id': '*2', address: 'bb', sig: '-60' },
      { '.id': '*1', sig: '-65', privacy: 'true' },
      { '.id': '*2', '.dead': 'true' },
    ]);
    expect(merged).toEqual([{ '.id': '*1', address: 'aa', sig: '-65', privacy: 'true' }]);
  });

  it('rows with no id merge by address', () => {
    expect(mergeScanRows([{ address: 'AA:BB', sig: '-70' }, { address: 'aa:bb', privacy: 'true' }]))
      .toEqual([{ address: 'aa:bb', sig: '-70', privacy: 'true' }]);
  });
});

describe('legacy scan as a script (#295)', () => {
  it('builds the terminal scan with as-value, SSID last', () => {
    const s = legacyScanScript('wlan1', 5)!;
    expect(s).toContain('/interface wireless scan "wlan1" duration=5 as-value');
    expect(s).toContain('($r->"privacy")');
    expect(s.indexOf('"ssid"')).toBeGreaterThan(s.indexOf('"channel"'));
  });

  it('refuses an interface name that could break out of the script', () => {
    expect(legacyScanScript('wlan1"] ; /system reboot ; ["', 5)).toBeNull();
    expect(legacyScanScript('wlan 1', 5)).toBeNull();
    expect(legacyScanScript('', 5)).toBeNull();
  });

  it('keeps the duration within bounds', () => {
    expect(legacyScanScript('wlan1', 0)).toContain('duration=1 ');
    expect(legacyScanScript('wlan1', 999)).toContain('duration=60 ');
  });

  it('parses the output into rows the aggregator reads as secured or open', () => {
    const out = 'A4:16:E7:92:06:78|true|-83|-101|18|2412/20-Ce/gn|Home|Net\r\n'
      + 'D0:F9:9B:45:A4:5A|false|-80|-101|21|2412/20-Ce/gn|Cafe\r\n'
      + '11:22:33:44:55:66|true|-70|-101|31|5180/20-Ceee/ac|\r\n'
      + 'garbage line\r\n';
    const rows = parseLegacyScanOutput(out);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ address: 'A4:16:E7:92:06:78', privacy: 'true', sig: '-83', ssid: 'Home|Net' });
    expect(rows[2].ssid).toBe('');
    const nets = aggregateAPScanRows([{ iface: 'wlan1', rows }], () => '');
    expect(nets.find((n) => n.ssid === 'Home|Net')?.security).toBe('secured');
    expect(nets.find((n) => n.ssid === 'Cafe')?.security).toBe('open');
    expect(nets.find((n) => n.hidden)?.security).toBe('secured');
  });

  it('leaves security unknown when the script output has no privacy value', () => {
    const rows = parseLegacyScanOutput('A4:16:E7:92:06:78||-83|-101|18|2412/20-Ce/gn|Home');
    expect('privacy' in rows[0]).toBe(false);
    expect(aggregateAPScanRows([{ iface: 'wlan1', rows }], () => '')[0].security).toBe('unknown');
  });
});
