import { AntennaAlignmentReader, alignmentRateMbps, normalizeAlignmentPeer } from '../antennaAlignment';
import { RouterOSTrapError } from '../RouterOSClient';

const missing = () => new RouterOSTrapError('no such command prefix');
const mac = 'AA:BB:CC:DD:EE:01';

describe('alignment telemetry normalization', () => {
  it('keeps local RX, peer RX, chain signals, SNR and rates distinct', () => {
    expect(normalizeAlignmentPeer({ 'mac-address': mac, 'signal-strength': '-61dBm@6Mbps',
      'tx-signal-strength': '-63', 'signal-strength-ch0': '-62', 'signal-strength-ch1': '-64',
      'signal-to-noise': '38', 'tx-ccq': '98%', 'rx-ccq': '97', 'tx-rate': '300Mbps', 'rx-rate': '866600000' }, 'wireless', 'registration'))
      .toMatchObject({ connected: true, signal_dbm: -61, remote_signal_dbm: -63, chain_signals: [-62, -64],
        snr_db: 38, tx_ccq: 98, rx_ccq: 97, tx_rate_mbps: 300, rx_rate_mbps: 866.6 });
  });
  it('reads v6 aggregate chain fields without using @6Mbps as a chain', () => {
    expect(normalizeAlignmentPeer({ 'signal-strength': '-61@6Mbps,-62,-64' }, 'wireless', 'registration').chain_signals).toEqual([-62, -64]);
    expect(normalizeAlignmentPeer({ 'signal-strength': '-61@6Mbps' }, 'wireless', 'registration').chain_signals).toEqual([]);
  });
  it('preserves chain positions and treats absent/invalid readings as unavailable', () => {
    const p = normalizeAlignmentPeer({ signal: '0', 'signal-strength-ch1': '-70', 'tx-ccq': '140', 'rx-ccq': '' }, 'wifi', 'registration');
    expect(p.signal_dbm).toBeNull();
    expect(p.chain_signals).toEqual([null, -70]);
    expect(p.tx_ccq).toBeNull();
    expect(p.rx_ccq).toBeNull();
    expect(normalizeAlignmentPeer({}, 'wifi', 'registration').snr_db).toBeNull();
  });
  it('never confuses W60G signal quality with received power', () => {
    expect(normalizeAlignmentPeer({ connected: 'yes', signal: '80', rssi: '-68', 'phy-rate': '2.3Gbps', distance: '160.9m', 'tx-sector-info': 'center' }, 'w60g', 'monitor'))
      .toMatchObject({ connected: true, signal_dbm: -68, signal_quality: 80, tx_rate_mbps: 2300, distance_m: 160.9, sector_info: 'center' });
    expect(normalizeAlignmentPeer({ connected: 'yes', signal: '80' }, 'w60g', 'monitor').signal_dbm).toBeNull();
  });
  it('does not mistake retained signal on a disconnected monitor for a link', () => {
    expect(normalizeAlignmentPeer({ status: 'searching-for-network', 'signal-strength': '-55' }, 'wireless', 'monitor').connected).toBe(false);
    expect(normalizeAlignmentPeer({ status: 'connected-to-ess' }, 'wireless', 'monitor').connected).toBe(true);
    expect(normalizeAlignmentPeer({ authorized: 'false' }, 'wifi', 'registration').connected).toBe(false);
  });
  it.each([['1Gbps', 1000], ['6.5Mbps-20MHz/1S', 6.5], ['54000kbps', 54], ['54000000', 54], ['0', 0], ['invalid', null], [undefined, null]])(
    'parses link rate %s', (input, expected) => expect(alignmentRateMbps(input)).toBe(expected));
});

describe('read-only antenna alignment reader', () => {
  function device(responses: Record<string, Record<string, string>[] | Error>) {
    return jest.fn(async (command: string, _params?: Record<string, string>) => {
      const result = responses[command] ?? missing();
      if (result instanceof Error) throw result;
      return result;
    });
  }
  it('finds legacy radios when the built-in wifi menu exists but is empty', async () => {
    const execute = device({ '/interface/wifi/print': [], '/interface/wireless/print': [{ name: 'wlan1', mode: 'bridge', password: 'never-return' }],
      '/interface/wireless/registration-table/print': [{ interface: 'wlan1', 'mac-address': mac, 'signal-strength': '-64' }] });
    const reader = new AntennaAlignmentReader(execute);
    const sample = await reader.read();
    expect(sample.radios[0]).toMatchObject({ package: 'wireless', peers: [{ signal_dbm: -64 }] });
    expect(JSON.stringify(sample)).not.toContain('never-return');
    execute.mockClear();
    await reader.read();
    expect(execute.mock.calls.map(([path]) => path)).toEqual(['/interface/wireless/print', '/interface/wireless/registration-table/print']);
    expect(execute.mock.calls.every(([path]) => path.endsWith('/print') || path.endsWith('/monitor'))).toBe(true);
  });
  it('reads every peer without selecting the strongest one', async () => {
    const execute = device({ '/interface/wifi/print': [{ name: 'wifi1', 'configuration.mode': 'ap' }],
      '/interface/wireless/print': [], '/interface/wifi/registration-table/print': [
        { interface: 'wifi1', 'mac-address': mac, signal: '-78' },
        { interface: 'wifi1', 'mac-address': 'AA:BB:CC:DD:EE:02', signal: '-50' },
        { interface: 'wifi2', 'mac-address': 'AA:BB:CC:DD:EE:03', signal: '-40' },
      ] });
    const sample = await new AntennaAlignmentReader(execute).read();
    expect(sample.radios[0].peers.map(p => p.signal_dbm)).toEqual([-78, -50]);
  });
  it('falls back to a one-shot station monitor and drops disconnected readings', async () => {
    const responses = { '/interface/wireless/print': [{ '.id': '*1', name: 'wlan1', mode: 'station-bridge' }],
      '/interface/wireless/registration-table/print': [], '/interface/wireless/monitor': [{ status: 'connected-to-ess', bssid: mac, 'signal-strength': '-60' }] };
    const execute = device(responses);
    const reader = new AntennaAlignmentReader(execute);
    expect((await reader.read()).radios[0].peers[0]).toMatchObject({ mac_address: mac, source: 'monitor', signal_dbm: -60 });
    expect(execute).toHaveBeenCalledWith('/interface/wireless/monitor', { numbers: 'wlan1', once: '' });
    responses['/interface/wireless/monitor'] = [{ status: 'searching-for-network', bssid: mac, 'signal-strength': '-60' }];
    expect((await reader.read()).radios[0].peers).toEqual([]);
  });
  it('supports pre-7.13 wifiwave2 radios', async () => {
    const execute = device({ '/interface/wifiwave2/print': [{ name: 'wifi1' }],
      '/interface/wifiwave2/registration-table/print': [{ interface: 'wifi1', 'mac-address': mac, signal: '-65' }] });
    expect((await new AntennaAlignmentReader(execute).read()).radios[0]).toMatchObject({ package: 'wifiwave2', peers: [{ signal_dbm: -65 }] });
  });
  it('reads legacy rows whose filtered stats omit signal strength', async () => {
    const execute = jest.fn(async (path: string, params?: Record<string, string>): Promise<Record<string, string>[]> => {
      if (path === '/interface/wireless/print') return [{ '.id': '*B', name: 'wlan1', mode: 'station-bridge' }, { name: 'wlan2', disabled: 'true' }];
      if (path.endsWith('/registration-table/print')) return params
        ? [{ interface: '*B', 'mac-address': mac }]
        : [{ interface: '*B', 'mac-address': mac, 'signal-strength': '-66@6Mbps,-67,-65' }];
      throw missing();
    });
    const sample = await new AntennaAlignmentReader(execute).read();
    expect(sample.radios[0].peers[0]).toMatchObject({ mac_address: mac, signal_dbm: -66, chain_signals: [-67, -65] });
    expect(execute).toHaveBeenCalledWith('/interface/wireless/registration-table/print');
    expect(sample.radios[1].peers).toEqual([]);
  });
  it('retries once=yes by interface name and enriches a station peer without RSSI', async () => {
    const execute = jest.fn(async (path: string, params?: Record<string, string>): Promise<Record<string, string>[]> => {
      if (path === '/interface/wireless/print') return [{ '.id': '*B', name: 'wlan1', mode: 'station-pseudobridge' }];
      if (path.endsWith('/registration-table/print')) return [{ interface: 'wlan1', 'mac-address': mac }];
      if (path === '/interface/wireless/monitor') {
        if (params?.numbers !== 'wlan1' || params.once !== 'yes') throw new RouterOSTrapError('invalid argument once');
        return [{ status: 'connected-to-ess', 'signal-strength': '-69', 'signal-strength-at-ch0': '-70', 'signal-strength-at-ch1': '-68' }];
      }
      throw missing();
    });
    const sample = await new AntennaAlignmentReader(execute).read();
    expect(sample.radios[0].peers).toHaveLength(1);
    expect(sample.radios[0].peers[0]).toMatchObject({ mac_address: mac, signal_dbm: -69, chain_signals: [-70, -68], source: 'monitor' });
    expect(execute).toHaveBeenCalledWith('/interface/wireless/monitor', { numbers: 'wlan1', once: 'yes' });
    expect(execute.mock.calls.some(([path]) => /\/(?:align|scan|set)$/.test(path))).toBe(false);
  });
  it('uses the plain legacy registration query when stats arguments are rejected', async () => {
    const execute = jest.fn(async (path: string, params?: Record<string, string>): Promise<Record<string, string>[]> => {
      if (path === '/interface/wireless/print') return [{ name: 'wlan1', mode: 'bridge' }];
      if (path.endsWith('/registration-table/print')) {
        if (params) throw new RouterOSTrapError('unknown parameter stats');
        return [{ interface: 'wlan1', 'mac-address': mac, 'signal-strength': '-62' }];
      }
      throw missing();
    });
    expect((await new AntennaAlignmentReader(execute).read()).radios[0].peers[0].signal_dbm).toBe(-62);
  });
  it('monitors individual W60G station interfaces without entering align mode', async () => {
    const execute = device({ '/interface/w60g/print': [{ name: 'wlan60-1', mode: 'ap-bridge' }],
      '/interface/w60g/station/print': [{ '.id': '*3', name: 'wlan60-station-1', parent: 'wlan60-1', 'remote-address': mac }],
      '/interface/w60g/station/monitor': [{ connected: 'true', rssi: '-62', signal: '70' }] });
    expect((await new AntennaAlignmentReader(execute).read()).radios[0].peers[0]).toMatchObject({ mac_address: mac, signal_dbm: -62 });
    expect(execute).toHaveBeenCalledWith('/interface/w60g/station/monitor', { numbers: '*3', once: '' });
    expect(execute.mock.calls.some(([path]) => /\/(?:align|scan|set)$/.test(path))).toBe(false);
  });
  it('reports command refusals, but propagates transport failure to discard the session', async () => {
    const responses: Record<string, Record<string, string>[] | Error> = {
      '/interface/wireless/print': [{ name: 'wlan1', mode: 'station-bridge' }],
      '/interface/wireless/registration-table/print': new RouterOSTrapError('not enough permissions'),
      '/interface/wireless/monitor': new RouterOSTrapError('not enough permissions'),
    };
    const reader = new AntennaAlignmentReader(device(responses));
    expect((await reader.read()).radios[0].error).toContain('permissions');
    responses['/interface/wireless/monitor'] = new Error('Connection closed');
    await expect(reader.read()).rejects.toThrow('Connection closed');
  });
  it('does not interpret a denied discovery query as an absent radio', async () => {
    const execute = device({ '/interface/wifi/print': new RouterOSTrapError('not enough permissions') });
    await expect(new AntennaAlignmentReader(execute).read()).rejects.toThrow('not enough permissions');
  });
});
