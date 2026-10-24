export interface AlignmentPeer {
  mac_address: string | null;
  connected: boolean;
  source: 'registration' | 'monitor';
  signal_dbm: number | null;
  remote_signal_dbm: number | null;
  chain_signals: (number | null)[];
  snr_db: number | null;
  tx_ccq: number | null;
  rx_ccq: number | null;
  tx_rate_mbps: number | null;
  rx_rate_mbps: number | null;
  signal_quality: number | null;
  sector_info: string | null;
  distance_m: number | null;
}

export interface AlignmentRadio {
  key: string;
  name: string;
  mac_address: string | null;
  package: 'wireless' | 'wifi' | 'wifiwave2' | 'w60g';
  mode: string | null;
  ssid: string | null;
  disabled: boolean;
  peers: AlignmentPeer[];
  error: string | null;
}

export interface AlignmentSnapshot {
  sampled_at: string;
  radios: AlignmentRadio[];
  warnings: string[];
}
