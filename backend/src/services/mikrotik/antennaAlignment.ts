import { RouterOSTrapError } from './RouterOSClient';

type Row = Record<string, string>;
type Execute = (command: string, params?: Row) => Promise<Row[]>;
export type AlignmentPackage = 'wireless' | 'wifi' | 'wifiwave2' | 'w60g';

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
  package: AlignmentPackage;
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

/** RouterOS adds units and, on some drivers, per-chain values after the total. */
function number(value: string | undefined): number | null {
  if (!value || value.length > 256) return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)/.exec(value);
  const n = match ? Number(match[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function bounded(value: string | undefined, min: number, max: number): number | null {
  const n = number(value);
  return n !== null && n >= min && n <= max ? n : null;
}

export function alignmentRateMbps(value: string | undefined): number | null {
  const n = number(value);
  if (n === null || n < 0) return null;
  const units = (value ?? '').toLowerCase();
  if (units.includes('gbps')) return n * 1000;
  if (units.includes('mbps')) return n;
  if (units.includes('kbps')) return n / 1000;
  // Unitless RouterOS API rates are bits/second, including wifi and W60G.
  return n / 1_000_000;
}

function mac(value: string | undefined): string | null {
  return value && /^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(value) && value !== '00:00:00:00:00:00'
    ? value.toUpperCase() : null;
}

const yes = (value: string | undefined) => value === 'yes' || value === 'true';

export function normalizeAlignmentPeer(row: Row, pkg: AlignmentPackage, source: AlignmentPeer['source']): AlignmentPeer {
  const w60g = pkg === 'w60g';
  const signal = w60g ? row.rssi : row['signal-strength'] || row.signal;
  const chains = Array.from({ length: 4 }, (_, i) => bounded(
    row[`signal-strength-ch${i}`] || row[`signal-strength-at-ch${i}`], -150, -1));
  // Some v6 drivers put chain readings inside signal-strength: -60@6Mbps,-62,-61.
  if (signal && signal.length <= 256 && !chains.some(v => v !== null)) {
    const values = signal.split(',').slice(1, 5);
    values.forEach((v, i) => { chains[i] = bounded(v, -150, -1); });
  }
  while (chains.length && chains[chains.length - 1] === null) chains.pop();
  const status = row.status ?? '';
  const connected = row.connected !== undefined ? yes(row.connected)
    : source === 'registration' ? row.authorized !== 'false' && row.authorized !== 'no'
    : status === 'connected-to-ess' || status === 'connected-to-ap' || status === 'connected';
  return {
    mac_address: mac(source === 'monitor'
      ? row.bssid ?? row['remote-address'] ?? row.remote ?? row['mac-address']
      : row['mac-address'] ?? row['remote-address'] ?? row.bssid ?? row.remote),
    connected,
    source,
    signal_dbm: bounded(signal, -150, -1),
    remote_signal_dbm: bounded(row['tx-signal-strength'], -150, -1),
    chain_signals: chains,
    snr_db: bounded(row['signal-to-noise'] ?? row['signal-to-noise-ratio'], 0, 100),
    tx_ccq: bounded(row['tx-ccq'] ?? row['overall-tx-ccq'], 0, 100),
    rx_ccq: bounded(row['rx-ccq'] ?? row['overall-rx-ccq'], 0, 100),
    tx_rate_mbps: alignmentRateMbps(row['tx-rate'] ?? row['tx-phy-rate'] ?? row['phy-rate']),
    rx_rate_mbps: alignmentRateMbps(row['rx-rate'] ?? row['rx-phy-rate']),
    // W60G's positive signal value is a quality index, never RSSI in dBm.
    signal_quality: w60g ? bounded(row.signal, 0, 100) : null,
    sector_info: w60g ? row['tx-sector-info']?.slice(0, 256) ?? null : null,
    distance_m: w60g ? bounded(row.distance, 0, 100_000) : null,
  };
}

function missingMenu(err: unknown): boolean {
  return err instanceof RouterOSTrapError && /no such command|bad command name|unknown command/i.test(err.message);
}

function permissionDenied(err: unknown): boolean {
  return err instanceof RouterOSTrapError && /permission|not permitted|access denied/i.test(err.message);
}

function disconnectedMonitor(row: Row): boolean {
  return row.connected === 'false' || row.connected === 'no'
    || /^(disabled|searching-for-network|initializing|searching-for-frequency|radar-detecting)$/.test(row.status ?? '');
}

/** Keep valid fields when another read/driver omits them, without mixing peers. */
function mergePeer(previous: AlignmentPeer, next: AlignmentPeer): AlignmentPeer {
  const present = Object.fromEntries(Object.entries(next).filter(([, value]) =>
    value !== null && (!Array.isArray(value) || value.some(v => v !== null))));
  const chain_signals = Array.from({ length: Math.max(previous.chain_signals.length, next.chain_signals.length) },
    (_, i) => next.chain_signals[i] ?? previous.chain_signals[i] ?? null);
  return { ...previous, ...present, chain_signals };
}

interface RegistrationSample { interface: string | undefined; peer: AlignmentPeer }

const RADIO_FIELDS = '.id,name,mac-address,mode,configuration.mode,ssid,configuration.ssid,disabled,master-interface';
const PEER_FIELDS = 'interface,mac-address,authorized,signal,signal-strength,tx-signal-strength,signal-strength-ch0,signal-strength-ch1,signal-strength-ch2,signal-strength-ch3,signal-strength-at-ch0,signal-strength-at-ch1,signal-to-noise,signal-to-noise-ratio,tx-ccq,rx-ccq,tx-rate,rx-rate';

/** A read-only reader owned by one short-lived, reusable DeviceCollector session. */
export class AntennaAlignmentReader {
  private packages: AlignmentPackage[] | null = null;

  constructor(private execute: Execute) {}

  private async probe(pkg: AlignmentPackage): Promise<Row[]> {
    const path = `/interface/${pkg}/print`;
    try {
      const rows = await this.execute(path, { '.proplist': RADIO_FIELDS });
      if (pkg === 'wireless' && rows.some(row => !row.name || !row.mode)) {
        const plain = await this.execute(path);
        if (plain.length) return plain;
      }
      return rows;
    } catch (err) {
      if (missingMenu(err)) return [];
      // Match the standalone tool if a legacy driver rejects the property list.
      // Only the explicitly selected metadata below ever leaves this reader.
      if (pkg === 'wireless' && err instanceof RouterOSTrapError && !permissionDenied(err)) {
        return this.execute(path);
      }
      throw err;
    }
  }

  private async legacyRegistrations(interfaces: Row[]): Promise<RegistrationSample[]> {
    const path = '/interface/wireless/registration-table/print';
    const names = new Map<string, string>();
    for (const row of interfaces) {
      if (row.name) {
        names.set(row.name, row.name);
        if (row['.id']) names.set(row['.id'], row.name);
      }
    }
    const samples = new Map<string, RegistrationSample>();
    let answered = false;
    let lastError: RouterOSTrapError | undefined;
    // First use exactly the successful standalone query. Older wireless drivers
    // may expose measurements only with stats/detail and without .proplist.
    const variants: (Row | undefined)[] = [undefined, { stats: '' }, { detail: '' }];
    for (const params of variants) {
      let rows: Row[];
      try {
        rows = params ? await this.execute(path, params) : await this.execute(path);
        answered = true;
      } catch (err) {
        if (!(err instanceof RouterOSTrapError) || permissionDenied(err)) throw err;
        lastError = err;
        continue;
      }
      rows.forEach((row, index) => {
        const iface = names.get(row.interface) ?? row.interface;
        const peer = normalizeAlignmentPeer(row, 'wireless', 'registration');
        const key = JSON.stringify([iface, peer.mac_address ?? row['.id'] ?? index]);
        const previous = samples.get(key);
        samples.set(key, { interface: iface, peer: previous ? mergePeer(previous.peer, peer) : peer });
      });
      if (samples.size && [...samples.values()].every(({ peer }) => !peer.connected || peer.signal_dbm !== null)) break;
    }
    if (!answered && lastError) throw lastError;
    return [...samples.values()];
  }

  private async monitor(path: string, target: Row, pkg: AlignmentPackage): Promise<Row[]> {
    const selectors = [...new Set((pkg === 'wireless'
      ? [target.name, target['.id']] : [target['.id'], target.name]).filter((s): s is string => !!s))];
    let lastError: RouterOSTrapError | undefined;
    let summary: Row[] = [];
    for (const selector of selectors) {
      for (const once of ['', 'yes']) {
        try {
          const rows = await this.execute(path, { numbers: selector, once });
          if (!rows.length) continue;
          // A successful AP summary can have no per-peer measurements. Try the
          // other once spelling/selector rather than stopping on metadata alone.
          if (pkg !== 'wireless' || rows.some(row =>
            normalizeAlignmentPeer(row, pkg, 'monitor').signal_dbm !== null
            || disconnectedMonitor(row))) return rows;
          summary = rows;
        } catch (err) {
          if (!(err instanceof RouterOSTrapError) || permissionDenied(err)) throw err;
          lastError = err;
        }
      }
    }
    if (summary.length) return summary;
    if (lastError) throw lastError;
    return [];
  }

  async read(): Promise<AlignmentSnapshot> {
    const radios: AlignmentRadio[] = [];
    const warnings: string[] = [];
    const menus = new Map<AlignmentPackage, Row[]>();
    if (this.packages === null) {
      // wifi exists without local radios on 7.13+. Probe the legacy menu too.
      for (const pkg of ['wifi', 'wireless', 'w60g'] as const) menus.set(pkg, await this.probe(pkg));
      if (!menus.get('wifi')?.length) menus.set('wifiwave2', await this.probe('wifiwave2'));
      this.packages = [...menus].filter(([, rows]) => rows.length > 0).map(([pkg]) => pkg);
    } else {
      for (const pkg of this.packages) menus.set(pkg, await this.probe(pkg));
    }

    for (const pkg of this.packages) {
      const allInterfaces = menus.get(pkg) ?? [];
      const interfaces = allInterfaces.filter(row => row.name).slice(0, 8);
      if (allInterfaces.length > 8) warnings.push(`${pkg}: showing the first 8 interfaces.`);
      let registrations: RegistrationSample[] = [];
      let registrationError = false;
      if (pkg !== 'w60g') {
        try {
          registrations = pkg === 'wireless'
            ? await this.legacyRegistrations(allInterfaces)
            : (await this.execute(`/interface/${pkg}/registration-table/print`, { '.proplist': PEER_FIELDS }))
              .map(row => ({ interface: row.interface, peer: normalizeAlignmentPeer(row, pkg, 'registration') }));
        } catch (err) {
          if (!(err instanceof RouterOSTrapError)) throw err;
          registrationError = true;
        }
      }
      let stations: Row[] = [];
      if (pkg === 'w60g') {
        stations = await this.execute('/interface/w60g/station/print', {
          '.proplist': '.id,name,parent,remote-address,disabled',
        });
      }
      for (const raw of interfaces) {
        const radio: AlignmentRadio = {
          key: `${pkg}:${raw.name}`, name: raw.name, mac_address: mac(raw['mac-address']), package: pkg,
          mode: raw['configuration.mode'] ?? raw.mode ?? null,
          ssid: raw['configuration.ssid'] ?? raw.ssid ?? null,
          disabled: yes(raw.disabled), peers: [], error: null,
        };
        radios.push(radio);
        if (radio.disabled) continue;
        const matches = registrations.filter(row => row.interface === radio.name || (raw['.id'] && row.interface === raw['.id']));
        radio.peers = matches.slice(0, 256).map(row => row.peer);
        if (matches.length > 256) {
          warnings.push(`${radio.name}: showing the first 256 peers.`);
        }
        if (registrationError) radio.error = 'Registration telemetry could not be read. Check the RouterOS account permissions.';
        // Legacy PTP bridge/AP drivers can also need monitor. Never enter align,
        // scan, or sniffer modes: those interrupt a working bridge.
        const missingSignal = !radio.peers.some(p => p.connected)
          || radio.peers.some(p => p.connected && p.signal_dbm === null);
        if (pkg === 'w60g' || (pkg === 'wireless' && missingSignal)) {
          const children = stations.filter(row => row.parent === radio.name && !yes(row.disabled));
          const targets = children.length ? children.slice(0, 8) : [raw];
          if (children.length > 8) warnings.push(`${radio.name}: monitoring the first 8 W60G peers.`);
          for (const target of targets) {
            const path = pkg === 'w60g' && children.length ? '/interface/w60g/station/monitor' : `/interface/${pkg}/monitor`;
            try {
              const rows = await this.monitor(path, target, pkg);
              let measured = false;
              for (const row of rows) {
                if (pkg === 'wireless' && !radio.ssid && row.ssid) radio.ssid = row.ssid.slice(0, 256);
                const peer = normalizeAlignmentPeer({ ...row, 'remote-address': row['remote-address'] ?? target['remote-address'] }, pkg, 'monitor');
                const isStation = radio.mode?.startsWith('station') ?? false;
                // A bridge/AP monitor has no station BSSID: its mac-address is
                // local. Do not mistake it for the selected remote peer.
                if (pkg === 'wireless' && !isStation && peer.mac_address === radio.mac_address) peer.mac_address = null;
                const known = peer.mac_address
                  ? radio.peers.find(p => p.mac_address === peer.mac_address)
                  : radio.peers.length === 1 ? radio.peers[0] : undefined;
                if (pkg === 'wireless' && known && disconnectedMonitor(row)) known.connected = false;
                const count = bounded(row['registered-clients'], 0, 100_000);
                if (pkg === 'wireless' && !isStation && !peer.mac_address
                  && (!known || (count !== null && count !== 1))) continue;
                // running-ap alone proves no peer connection. Attribute a signal
                // only to an explicitly matching or single registered peer; an
                // AP-wide reading with several clients is ambiguous.
                if (pkg === 'wireless' && row.connected === undefined && peer.signal_dbm !== null
                  && known?.connected && (!row.status || row.status === 'running-ap')
                  && (peer.mac_address !== null || count === null || count === 1)) peer.connected = true;
                if (peer.connected) {
                  if (!peer.mac_address && known) peer.mac_address = known.mac_address;
                  const existing = peer.mac_address
                    ? radio.peers.findIndex(p => p.mac_address === peer.mac_address)
                    : known ? radio.peers.indexOf(known) : -1;
                  if (existing === -1) radio.peers.push(peer);
                  else radio.peers[existing] = mergePeer(radio.peers[existing], peer);
                  if (peer.signal_dbm !== null) measured = true;
                }
              }
              if (measured) radio.error = null;
            } catch (err) {
              if (!(err instanceof RouterOSTrapError)) throw err;
              radio.error = 'Radio monitor could not be read. Check the RouterOS account permissions and package support.';
            }
          }
        }
      }
    }
    return { sampled_at: new Date().toISOString(), radios, warnings };
  }
}
