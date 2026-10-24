import { AntennaAlignmentReader } from '../antennaAlignment';
import { RouterOSTrapError } from '../RouterOSClient';

type Row = Record<string, string>;
const mac = 'AA:BB:CC:DD:EE:01';
const local = 'AA:BB:CC:DD:EE:02';
const other = 'AA:BB:CC:DD:EE:03';
const iface = '/interface/wireless/print';
const registrations = '/interface/wireless/registration-table/print';
const monitor = '/interface/wireless/monitor';
const missing = () => new RouterOSTrapError('no such command prefix');
const radio: Row = { '.id': '*B', name: 'TestRadioA', mode: 'bridge', 'mac-address': local };
const registered: Row = { interface: 'TestRadioA', 'mac-address': mac };

function device(responses: Record<string, Row[] | Error>) {
  return jest.fn(async (path: string, _params?: Row): Promise<Row[]> => {
    const rows = responses[path] ?? missing();
    if (rows instanceof Error) throw rows;
    return rows;
  });
}

describe('legacy 5 GHz PTP compatibility', () => {
  it('uses the original plain registration query first and stops when it has RSSI', async () => {
    const execute = device({ [iface]: [radio], [registrations]: [{ ...registered, 'signal-strength': '-63' }] });
    const sample = await new AntennaAlignmentReader(execute).read();
    expect(sample.radios[0].peers[0].signal_dbm).toBe(-63);
    expect(execute.mock.calls.filter(([path]) => path === registrations)).toEqual([[registrations]]);
    expect(execute.mock.calls.some(([path]) => path === monitor)).toBe(false);
  });

  it('retries unfiltered stats, merging interface IDs/names without mixing another radio using the same MAC', async () => {
    const execute = jest.fn(async (path: string, params?: Row): Promise<Row[]> => {
      if (path === iface) return [radio, { '.id': '*C', name: 'TestRadioB', mode: 'bridge' }];
      if (path === registrations) {
        if (!params) return [
          { ...registered, interface: '*B', 'tx-rate': '400Mbps', 'tx-ccq': '98', 'signal-strength-ch0': '-64' },
          { ...registered, interface: 'TestRadioB', 'signal-strength': '-80' },
        ];
        expect(params).toEqual({ stats: '' });
        return [{ ...registered, 'signal-strength': '-63', 'signal-strength-ch1': '-62' }];
      }
      throw missing();
    });
    const { radios } = await new AntennaAlignmentReader(execute).read();
    expect(radios[0].peers).toHaveLength(1);
    expect(radios[0].peers[0]).toMatchObject({ signal_dbm: -63, tx_rate_mbps: 400, tx_ccq: 98, chain_signals: [-64, -62] });
    expect(radios[1].peers[0].signal_dbm).toBe(-80);
  });

  it('tries unfiltered detail if stats is rejected and the plain reply has no signal', async () => {
    const execute = jest.fn(async (path: string, params?: Row): Promise<Row[]> => {
      if (path === iface) return [radio];
      if (path === registrations) {
        if (params && 'stats' in params) throw new RouterOSTrapError('unknown parameter stats');
        return [{ ...registered, ...(params?.detail === '' ? { 'signal-strength': '-67' } : {}) }];
      }
      throw missing();
    });
    expect((await new AntennaAlignmentReader(execute).read()).radios[0].peers[0].signal_dbm).toBe(-67);
    expect(execute).toHaveBeenCalledWith(registrations, { detail: '' });
  });

  it('falls back to plain discovery when .proplist is rejected without exposing configuration', async () => {
    const execute = jest.fn(async (path: string, params?: Row): Promise<Row[]> => {
      if (path === iface) {
        if (params) throw new RouterOSTrapError('unknown parameter .proplist');
        return [{ ...radio, ssid: 'test-link', password: 'never-expose-this' }];
      }
      if (path === registrations) return [{ ...registered, 'signal-strength': '-63' }];
      throw missing();
    });
    const sample = await new AntennaAlignmentReader(execute).read();
    expect(sample.radios[0]).toMatchObject({ name: 'TestRadioA', ssid: 'test-link', peers: [{ signal_dbm: -63 }] });
    expect(JSON.stringify(sample)).not.toContain('never-expose-this');
  });

  it('recovers missing metadata from a successful but sparse filtered discovery', async () => {
    const execute = jest.fn(async (path: string, params?: Row): Promise<Row[]> => {
      if (path === iface) return params ? [{ '.id': '*B', name: 'TestRadioA' }] : [radio];
      if (path === registrations) return [{ ...registered, 'signal-strength': '-63' }];
      throw missing();
    });
    expect((await new AntennaAlignmentReader(execute).read()).radios[0].mode).toBe('bridge');
  });

  it('enriches a bridge peer with once=yes after a metadata-only monitor result', async () => {
    const execute = jest.fn(async (path: string, params?: Row): Promise<Row[]> => {
      if (path === iface) return [radio];
      if (path === registrations) return [{ ...registered, 'tx-rate': '400Mbps' }];
      if (path === monitor) return [{ status: 'running-ap', 'registered-clients': '1', ssid: 'test-link', 'mac-address': local,
        ...(params?.once === 'yes' ? { 'signal-strength': '-65', 'tx-ccq': '97' } : {}) }];
      throw missing();
    });
    const { radios } = await new AntennaAlignmentReader(execute).read();
    expect(radios[0].peers).toHaveLength(1);
    expect(radios[0]).toMatchObject({ ssid: 'test-link', peers: [{ mac_address: mac, connected: true, source: 'monitor', signal_dbm: -65, tx_rate_mbps: 400, tx_ccq: 97 }] });
    expect(execute.mock.calls.filter(([path]) => path === monitor)).toEqual([
      [monitor, { numbers: 'TestRadioA', once: '' }], [monitor, { numbers: 'TestRadioA', once: 'yes' }],
    ]);
    expect(execute.mock.calls.some(([path]) => /\/(?:align|scan|set)$/.test(path))).toBe(false);
  });

  it('does not invent RX signal from running-ap, noise floor or CCQ', async () => {
    const execute = device({ [iface]: [radio], [registrations]: [registered],
      [monitor]: [{ status: 'running-ap', 'registered-clients': '1', 'noise-floor': '-103', 'overall-tx-ccq': '99' }] });
    const { peers } = (await new AntennaAlignmentReader(execute).read()).radios[0];
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ connected: true, signal_dbm: null, source: 'registration' });
  });

  it('does not assign an unidentified AP reading to several clients', async () => {
    const execute = device({ [iface]: [radio], [registrations]: [registered, { ...registered, 'mac-address': other }],
      [monitor]: [{ connected: 'yes', status: 'running-ap', 'registered-clients': '2', 'signal-strength': '-50' }] });
    const { peers } = (await new AntennaAlignmentReader(execute).read()).radios[0];
    expect(peers).toHaveLength(2);
    expect(peers.map(p => p.signal_dbm)).toEqual([null, null]);
  });

  it('uses the explicit monitor MAC even when another client already has RX signal', async () => {
    const execute = device({ [iface]: [radio], [registrations]: [
      { ...registered, 'signal-strength': '-80' }, { ...registered, 'mac-address': other },
    ], [monitor]: [{ status: 'running-ap', 'registered-clients': '2', 'remote-address': other, 'signal-strength': '-64' }] });
    const { peers } = (await new AntennaAlignmentReader(execute).read()).radios[0];
    expect(peers.map(p => p.signal_dbm)).toEqual([-80, -64]);
  });

  it('does not display retained monitor RSSI after an explicit disconnect', async () => {
    const execute = device({ [iface]: [{ ...radio, mode: 'station-bridge' }], [registrations]: [registered],
      [monitor]: [{ status: 'searching-for-network', bssid: mac, 'signal-strength': '-50' }] });
    expect((await new AntennaAlignmentReader(execute).read()).radios[0].peers[0])
      .toMatchObject({ connected: false, signal_dbm: null });
  });

  it('stops retries on permissions errors and propagates transport failure', async () => {
    const execute = device({ [iface]: [radio], [registrations]: new RouterOSTrapError('not enough permissions'),
      [monitor]: new RouterOSTrapError('not enough permissions') });
    expect((await new AntennaAlignmentReader(execute).read()).radios[0].error).toContain('permissions');
    expect(execute.mock.calls.filter(([path]) => path === registrations)).toHaveLength(1);
    expect(execute.mock.calls.filter(([path]) => path === monitor)).toHaveLength(1);
    const failed = device({ [iface]: [radio], [registrations]: new Error('Connection closed') });
    await expect(new AntennaAlignmentReader(failed).read()).rejects.toThrow('Connection closed');
    expect(failed.mock.calls.filter(([path]) => path === registrations)).toHaveLength(1);
  });
});
