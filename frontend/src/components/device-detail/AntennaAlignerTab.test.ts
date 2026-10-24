import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Device } from '../../types';
import type { AlignmentPeer, AlignmentSnapshot } from '../../types/antennaAlignment';
import AntennaAlignerTab from './AntennaAlignerTab';

vi.mock('../../store/siteStore', () => ({ useSiteStore: (selector: (s: { currentSiteId: number }) => unknown) => selector({ currentSiteId: 1 }) }));
vi.mock('../../hooks/useDateTimeFormat', () => ({ useDateTimeFormat: () => ({ formatTime: () => '14:30:00' }) }));
vi.mock('../../services/api', () => ({ devicesApi: { list: vi.fn() }, wirelessApi: { alignment: vi.fn() } }));

const device = { id: 1, name: 'Test radio', ip_address: '192.0.2.1', device_type: 'wisp' } as Device;
const peer: AlignmentPeer = {
  mac_address: 'AA:BB:CC:DD:EE:01', connected: true, source: 'registration', signal_dbm: null,
  remote_signal_dbm: null, chain_signals: [], snr_db: null, tx_ccq: null, rx_ccq: null,
  tx_rate_mbps: 400, rx_rate_mbps: null, signal_quality: null, sector_info: null, distance_m: null,
};

function render(reading: AlignmentPeer) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const snapshot: AlignmentSnapshot = { sampled_at: new Date().toISOString(), warnings: [], radios: [{
    key: 'wireless:TestRadioA', name: 'TestRadioA', mac_address: null, package: 'wireless', mode: 'bridge', ssid: 'test-link',
    disabled: false, peers: [reading], error: null,
  }] };
  client.setQueryData(['devices', 1], []);
  client.setQueryData(['antenna-alignment', 1, 1], snapshot);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AntennaAlignerTab, { device })));
  client.clear();
  return html;
}

describe('alignment link state', () => {
  beforeEach(() => vi.stubGlobal('document', { hidden: false, documentElement: {} }));
  afterEach(() => vi.unstubAllGlobals());

  it('shows a registered peer without RSSI as signal unavailable, retaining other measurements', () => {
    const html = render(peer);
    expect(html).toContain('Signal unavailable');
    expect(html).toContain('The peer is registered');
    expect(html).toContain('400 Mbps');
    expect(html).not.toContain('No link');
    expect(html).not.toContain('Last reading');
  });

  it('shows a disconnected peer as no link without using its retained RX value', () => {
    const html = render({ ...peer, connected: false, signal_dbm: -50 });
    expect(html).toContain('No link');
    expect(html).not.toContain('Signal unavailable');
    expect(html).not.toContain('>-50<');
  });

  it('shows live RX readings when the connected peer supplies them', () => {
    const html = render({ ...peer, signal_dbm: -63 });
    expect(html).toContain('>Live<');
    expect(html).toContain('>-63<');
    expect(html).not.toContain('Signal unavailable');
  });
});
