import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, X, Check, AlertCircle, Activity, Cpu, Link2, Trash2, Plus, Network, Users, Wifi, ShieldCheck, AlertTriangle } from 'lucide-react';
import { devicesApi, metricsApi } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import ChangeGuardDialog, { guardOutcomeMessage, LockoutVerdictDialog, lockoutVerdictOf, type GuardResult, type LockoutVerdict } from '../ChangeGuardDialog';
import type { SwitchPort, Vlan, TrafficPoint, PortMonitorData, PortClient } from '../../types';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';

interface Props {
  deviceId: number;
  deviceName?: string;
  autoOpenBridge?: string;
  onBridgeOpened?: () => void;
}

interface PortEditForm {
  disabled: boolean;
  comment: string;
  mtu: number;
  poe_out: 'auto-on' | 'forced-on' | 'off' | '';
  fec_mode: 'clause-74' | 'clause-91' | 'off' | '';
  tx_flow_control: 'on' | 'off' | 'auto' | '';
  rx_flow_control: 'on' | 'off' | 'auto' | '';
  auto_negotiation: boolean | null; // null = no change
  speed: string;
  vlan_mode: 'access' | 'trunk' | 'none';
  pvid: number;
  tagged_vlans: string; // comma-separated string
}

interface CreateTrunkForm {
  name: string;
  mode: '802.3ad' | 'balance-xor' | 'active-backup';
  lacp_rate: 'slow' | 'fast';
  transmit_hash_policy: 'layer2' | 'layer2+3' | 'layer3+4' | '';
  mtu: string;
  min_links: string;
}

interface BondEditForm {
  mode: '802.3ad' | 'balance-xor' | 'active-backup';
  lacp_rate: 'slow' | 'fast';
  transmit_hash_policy: 'layer2' | 'layer2+3' | 'layer3+4' | '';
  mtu: string;
  min_links: string;
  members: string[];
}

function portState(port: SwitchPort): 'up' | 'down' | 'disabled' {
  if (port.disabled) return 'disabled';
  if (port.running) return 'up';
  return 'down';
}

function PortTile({
  port, selected, hovered, isMember, watts,
  onClick, onMouseEnter, onMouseLeave, onDoubleClick,
}: {
  port: SwitchPort; selected: boolean; hovered: boolean; isMember?: boolean; watts?: number;
  onClick: (e: React.MouseEvent) => void;
  onMouseEnter: () => void; onMouseLeave: () => void; onDoubleClick: () => void;
}) {
  const state = portState(port);
  const bg = selected ? 'var(--accent)' : state === 'up' ? 'var(--port-up-bg)' : state === 'down' ? 'var(--port-down-bg)' : 'var(--surface-3)';
  const border = isMember && !selected ? 'var(--warn)' : selected ? 'var(--accent)' : state === 'up' ? 'var(--port-up-border)' : state === 'down' ? 'var(--port-down-border)' : 'var(--line)';
  const textColor = selected ? '#ffffff' : state === 'up' ? 'var(--good)' : state === 'down' ? 'var(--bad)' : 'var(--ink-4)';
  const ledBg = selected ? '#ffffff' : state === 'up' ? 'var(--good)' : 'transparent';
  return (
    <div
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDoubleClick={onDoubleClick}
      title={`${port.name}${port.comment ? ` — ${port.comment}` : ''}${port.speed ? ` · ${port.speed}` : ''}${watts && watts > 0 ? ` · ${watts.toFixed(1)}W PoE` : ''}`}
      style={{
        width: 46, height: 46, borderRadius: 4, position: 'relative', flexShrink: 0,
        background: bg, border: `1px solid ${border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color: textColor,
        fontFamily: 'Geist Mono, monospace', fontSize: 10, fontWeight: 600,
        opacity: hovered ? 0.8 : 1, transition: 'opacity 0.1s',
      }}
    >
      <div style={{
        position: 'absolute', top: 4, right: 4, width: 5, height: 5, borderRadius: 999,
        background: ledBg,
        boxShadow: state === 'up' && !selected ? '0 0 6px var(--accent)' : 'none',
      }} />
      <span>{portLabel(port.name)}</span>
      {watts && watts > 0 ? (
        <span style={{
          position: 'absolute', bottom: 2, left: 0, right: 0, textAlign: 'center',
          fontSize: 7, fontWeight: 700, color: selected ? '#fff' : '#f59e0b',
          lineHeight: 1, letterSpacing: 0,
        }}>
          {watts.toFixed(0)}W
        </span>
      ) : null}
    </div>
  );
}

function portLabel(name: string): string {
  if (name.startsWith('sfp-sfpplus')) return `P${name.replace('sfp-sfpplus', '')}`;
  if (name.startsWith('sfp')) return `S${name.replace('sfp', '')}`;
  if (name.startsWith('combo')) return `C${name.replace('combo', '')}`;
  if (name.startsWith('ether')) return name.replace('ether', '');
  if (name.startsWith('bridge')) return name.replace('bridge', '') || 'BR';
  const bondMatch = name.match(/^bond(\d*)$/i);
  if (bondMatch) return `B${bondMatch[1]}`;
  const lagMatch = name.match(/^lag(\d*)$/i);
  if (lagMatch) return `L${lagMatch[1]}`;
  if (/^qsfp/i.test(name) && !name.match(/-\d+-\d+$/)) {
    return `Q${name.match(/-(\d+)$/)?.[1] ?? ''}`;
  }
  return name.slice(0, 4);
}

interface QsfpCage {
  key: string;
  label: string;
  /** Actual breakout lane ports (empty for single-mode cages). */
  lanes: SwitchPort[];
  /** Set when the cage is a single non-broken-out QSFP port; renders 4 virtual lanes. */
  singlePort?: SwitchPort;
}

/** Group QSFP ports into cage objects.
 *  - Breakout (qsfp28-1-1..4): real lanes with individual statuses, but if only 1 lane is
 *    running treat it as a single-cable connection and show all lanes green.
 *  - Single mode (qsfp28-1): synthetic cage with 4 virtual lanes all sharing the port status.
 */
function groupQsfpCages(ports: SwitchPort[]): { cages: QsfpCage[]; individual: SwitchPort[] } {
  const lanesByKey = new Map<string, SwitchPort[]>();
  for (const port of ports) {
    const m = port.name.match(/^(qsfp[^-]*(?:-[^-\d][^-]*)*-\d+)-(\d+)$/i);
    if (m) {
      const key = m[1];
      if (!lanesByKey.has(key)) lanesByKey.set(key, []);
      lanesByKey.get(key)!.push(port);
    }
  }

  const cageKeys = new Set([...lanesByKey.keys()].filter(k => lanesByKey.get(k)!.length > 1));
  const laneNames = new Set<string>();
  const cages: QsfpCage[] = [];

  for (const key of cageKeys) {
    const lanes = lanesByKey.get(key)!.sort((a, b) =>
      parseInt(a.name.split('-').pop() ?? '0') - parseInt(b.name.split('-').pop() ?? '0')
    );
    lanes.forEach(p => laneNames.add(p.name));
    const cageNum = key.match(/-(\d+)$/)?.[1] ?? '?';
    cages.push({ key, label: `Q${cageNum}`, lanes });
  }

  const remaining = ports.filter(p => !laneNames.has(p.name));

  // Single-mode QSFP ports (no lane suffix) → synthetic cage
  for (const port of remaining.filter(p => /^qsfp/i.test(p.name))) {
    const cageNum = port.name.match(/-(\d+)$/)?.[1] ?? '?';
    cages.push({ key: port.name, label: `Q${cageNum}`, lanes: [], singlePort: port });
  }

  cages.sort((a, b) =>
    parseInt(a.key.match(/-(\d+)$/)?.[1] ?? '0') - parseInt(b.key.match(/-(\d+)$/)?.[1] ?? '0')
  );

  return { cages, individual: remaining.filter(p => !/^qsfp/i.test(p.name)) };
}

const TRAFFIC_RANGES = ['1h', '3h', '6h', '12h', '24h'] as const;

function formatBps(val: number): string {
  if (val >= 1e9) return `${(val / 1e9).toFixed(2)} GB/s`;
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)} MB/s`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(val)} B/s`;
}

function PortTrafficGraph({
  deviceId, portName, range, onRangeChange,
}: {
  deviceId: number;
  portName: string;
  range: string;
  onRangeChange: (r: string) => void;
}) {
  const { data: rawTraffic = [], isLoading } = useQuery({
    queryKey: ['traffic', deviceId, portName, range],
    queryFn: () => metricsApi.interfaceTraffic(deviceId, portName, range).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const compact = range === '1h' || range === '3h';
  const trafficData = (rawTraffic as TrafficPoint[]).map((p) => ({
    time: new Date(p.time).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit',
      ...(compact ? {} : { month: 'short', day: 'numeric' }),
    }),
    rx: Math.round(p.rx),
    tx: Math.round(p.tx),
  }));

  const rxPeak = trafficData.length > 0 ? Math.max(...trafficData.map(d => d.rx)) : 0;
  const txPeak = trafficData.length > 0 ? Math.max(...trafficData.map(d => d.tx)) : 0;

  return (
    <div className="card p-5 flex flex-col h-full">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 shrink-0">
        <div>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            {portName} · throughput
          </div>
          <div className="mono text-[11px] mt-[2px]" style={{ color: 'var(--ink-3)' }}>
            {range} · 30s buckets
          </div>
        </div>
        <div className="flex gap-[4px]">
          {TRAFFIC_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => onRangeChange(r)}
              className="mono text-[11px] px-[8px] py-[4px] rounded-[5px] transition-colors"
              style={{
                background: range === r ? 'var(--surface-3)' : 'transparent',
                color: range === r ? 'var(--ink)' : 'var(--ink-3)',
                border: '1px solid var(--line)',
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-6 mb-3 shrink-0">
        <div>
          <div className="mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-4)' }}>RX peak</div>
          <div className="mono num-tab text-[18px] font-semibold" style={{ color: 'var(--accent)' }}>{formatBps(rxPeak)}</div>
        </div>
        <div>
          <div className="mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-4)' }}>TX peak</div>
          <div className="mono num-tab text-[18px] font-semibold" style={{ color: 'var(--violet)' }}>{formatBps(txPeak)}</div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex-1 min-h-[160px] flex items-center justify-center mono text-[12px]" style={{ color: 'var(--ink-4)' }}>
          Loading traffic data…
        </div>
      ) : trafficData.length === 0 ? (
        <div className="flex-1 min-h-[160px] flex items-center justify-center mono text-[12px]" style={{ color: 'var(--ink-4)' }}>
          No traffic data for {portName} in this range
        </div>
      ) : (
        <div className="flex-1 min-h-[160px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trafficData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" opacity={0.5} />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'var(--ink-4)' }} interval="preserveStartEnd" />
              <YAxis tickFormatter={formatBps} tick={{ fontSize: 10, fill: 'var(--ink-4)' }} width={72} />
              <Tooltip
                formatter={(v) => formatBps(v as number)}
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'var(--ink)',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="rx" stroke="var(--accent)" name="RX" dot={false} strokeWidth={1.6} />
              <Line type="monotone" dataKey="tx" stroke="var(--violet)" name="TX" dot={false} strokeWidth={1.6} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function formatPps(val: number): string {
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)} Mpps`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)} Kpps`;
  return `${Math.round(val)} pps`;
}

function PortPacketGraph({
  deviceId, portName, range,
}: {
  deviceId: number;
  portName: string;
  range: string;
}) {
  const { data: rawPackets = [], isLoading } = useQuery({
    queryKey: ['packets', deviceId, portName, range],
    queryFn: () => metricsApi.interfacePackets(deviceId, portName, range).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const compact = range === '1h' || range === '3h';
  const packetData = (rawPackets as TrafficPoint[]).map((p) => ({
    time: new Date(p.time).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit',
      ...(compact ? {} : { month: 'short', day: 'numeric' }),
    }),
    rx: Math.round(p.rx),
    tx: Math.round(p.tx),
  }));

  return (
    <div className="card p-5 flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <Activity className="w-4 h-4 text-purple-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          {portName} — Packets/s
        </h3>
      </div>

      {isLoading ? (
        <div className="flex-1 min-h-[200px] flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
          Loading packet data…
        </div>
      ) : packetData.length === 0 ? (
        <div className="flex-1 min-h-[200px] flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
          No packet data yet for {portName} in the selected range
        </div>
      ) : (
        <div className="flex-1 min-h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={packetData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tickFormatter={formatPps} tick={{ fontSize: 10 }} width={72} />
              <Tooltip
                formatter={(v) => formatPps(v as number)}
                contentStyle={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="rx" stroke="#8b5cf6" name="RX packets" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="tx" stroke="#f59e0b" name="TX packets" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function PortTooltip({ port }: { port: SwitchPort }) {
  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 bg-gray-900 dark:bg-slate-700 text-white text-xs rounded-lg px-3 py-2 z-10 shadow-lg pointer-events-none">
      <div className="font-semibold mb-1">{port.name}</div>
      <div>Status: {port.disabled ? 'Disabled' : port.running ? 'Up' : 'Down'}</div>
      {port.speed && <div>Speed: {port.speed}</div>}
      {port.mtu && <div>MTU: {port.mtu}{port.config_json?.['l2mtu'] ? ` (L2: ${port.config_json['l2mtu']})` : ''}</div>}
      {port.mac_address && <div>MAC: {port.mac_address}</div>}
      {port.bridgeInfo?.pvid && <div>PVID: {port.bridgeInfo.pvid}</div>}
      {port.comment && <div>Note: {port.comment}</div>}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900 dark:border-t-slate-700" />
    </div>
  );
}

function PortInfoCard({ deviceId, portName }: { deviceId: number; portName: string }) {
  const { data: monitor, isLoading } = useQuery({
    queryKey: ['port-monitor', deviceId, portName],
    queryFn: () => devicesApi.getPortMonitor(deviceId, portName).then((r) => r.data),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <div className="card p-5 flex items-center justify-center h-full min-h-[200px]">
        <RefreshCw className="w-4 h-4 animate-spin text-gray-400" />
      </div>
    );
  }

  const d = monitor as PortMonitorData | undefined;
  if (!d || Object.keys(d).length === 0) {
    return (
      <div className="card p-5 flex items-center justify-center h-full min-h-[200px]">
        <p className="text-sm text-gray-400 dark:text-slate-500 text-center">No physical info available</p>
      </div>
    );
  }

  const isSfp = d['sfp-module-present'] === 'true';

  const infoRow = (label: string, value: string | undefined, valueColor?: string) => {
    if (!value || value === '' || value === 'none' || value === '0') return null;
    const isStatus = label === 'Status';
    const statusColor = isStatus ? (value.includes('ok') || value === 'true' ? 'var(--good)' : value.includes('err') ? 'var(--bad)' : 'var(--ink-2)') : undefined;
    return (
      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{label}</span>
        <span className="mono" style={{ color: valueColor ?? statusColor ?? 'var(--ink-2)', fontSize: 12, textAlign: 'right' }}>{value}</span>
      </div>
    );
  };

  return (
    <div className="card p-4 overflow-y-auto">
      <div className="text-[13px] font-semibold mb-3" style={{ color: 'var(--ink)' }}>Port info</div>

      <div>
        {infoRow('Status', d['status'])}
        {infoRow('Rate', d['rate'])}
        {infoRow('Full Duplex', d['full-duplex'])}
        {infoRow('Auto-Neg.', d['auto-negotiation'])}
        {infoRow('TX Flow Ctrl', d['tx-flow-control'])}
        {infoRow('RX Flow Ctrl', d['rx-flow-control'])}
        {infoRow('FEC Mode', d['fec-mode'])}
      </div>

      {isSfp && (
        <>
          <div style={{ marginTop: 12, marginBottom: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
            <span className="mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--accent)' }}>SFP Optic</span>
          </div>
          <div className="space-y-0">
            {infoRow('Type', d['sfp-type'])}
            {infoRow('Connector', d['sfp-connector-type'])}
            {infoRow('Wavelength', d['sfp-wavelength'] ? `${d['sfp-wavelength']} nm` : undefined)}
            {infoRow('Vendor', d['sfp-vendor-name'])}
            {infoRow('Part #', d['sfp-vendor-part-number'])}
            {infoRow('Serial #', d['sfp-vendor-serial'])}
            {infoRow('Rev.', d['sfp-vendor-revision'])}
            {infoRow('Mfg. Date', d['sfp-manufacturing-date'])}
            {infoRow('Temperature', d['sfp-temperature'] ? `${d['sfp-temperature']} °C` : undefined)}
            {infoRow('Supply Volt.', d['sfp-supply-voltage'] ? `${d['sfp-supply-voltage']} V` : undefined)}
            {infoRow('TX Bias', d['sfp-tx-bias-current'] ? `${d['sfp-tx-bias-current']} mA` : undefined)}
            {infoRow('TX Power', d['sfp-tx-power'] ? `${d['sfp-tx-power']} dBm` : undefined)}
            {infoRow('RX Power', d['sfp-rx-power'] ? `${d['sfp-rx-power']} dBm` : undefined)}
            {infoRow('Cable (Cu)', d['sfp-link-length-copper'] ? `${d['sfp-link-length-copper']} m` : undefined)}
            {infoRow('Cable (MM)', d['sfp-link-length-multimode'] ? `${d['sfp-link-length-multimode']} m` : undefined)}
            {infoRow('Cable (SM)', d['sfp-link-length-singlemode'] ? `${d['sfp-link-length-singlemode']} km` : undefined)}
          </div>
        </>
      )}
    </div>
  );
}

// Table of client rows, reused for the connected list and the "view MAC table" disclosure.
function PortClientRows({ clients }: { clients: PortClient[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Host / Vendor</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">MAC</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">IP</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">VLAN</th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Connected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50">
          {clients.map((c, i) => {
            const name = c.custom_name || c.hostname;
            return (
              <tr key={c.mac_address}
                className={clsx('transition-colors hover:bg-blue-50/40 dark:hover:bg-slate-700/30',
                  i % 2 === 0 ? 'bg-white dark:bg-slate-900/20' : 'bg-gray-50 dark:bg-slate-800/40')}>
                <td className="px-4 py-2.5">
                  <Link to={`/clients/${encodeURIComponent(c.mac_address)}`}
                    className="font-medium text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1.5">
                    {c.client_type === 'wireless' && <Wifi className="w-3 h-3 flex-shrink-0" />}
                    {name || <span className="text-gray-400 dark:text-slate-500 italic">No hostname</span>}
                  </Link>
                  {c.vendor && <div className="text-xs text-gray-400 dark:text-slate-500 truncate">{c.vendor}</div>}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-600 dark:text-slate-400">{c.mac_address}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-600 dark:text-slate-400">{c.ip_address || '—'}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                  {c.vlan_id != null
                    ? <span className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded font-mono">{c.vlan_id}</span>
                    : '—'}
                </td>
                <td className="px-4 py-2.5 text-right text-xs text-gray-500 dark:text-slate-400"
                  title={c.first_seen ? new Date(c.first_seen).toLocaleString() : undefined}>
                  {c.first_seen ? formatDistanceToNow(new Date(c.first_seen), { addSuffix: false }) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Clients on a single port. The bridge FDB lists every MAC reachable *through*
// a port, so on an uplink/trunk that's the whole network — not what's physically
// plugged in. We classify the port and only show genuinely-connected clients by
// default, with a disclosure to view the full MAC table.
function PortClientsCard({ deviceId, portName }: { deviceId: number; portName: string }) {
  const [showMacTable, setShowMacTable] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['port-clients', deviceId, portName],
    queryFn: () => devicesApi.getPortClients(deviceId, portName).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: macTable } = useQuery({
    queryKey: ['port-clients-all', deviceId, portName],
    queryFn: () => devicesApi.getPortClients(deviceId, portName, true).then((r) => r.data),
    enabled: showMacTable,
  });

  const isUplink = data?.classification === 'uplink';
  const connected = data?.clients ?? [];

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <Users className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Connected Clients
          <span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500 font-mono">{portName}</span>
        </h3>
        {!isLoading && !isUplink && (
          <span className="ml-auto text-xs text-gray-400 dark:text-slate-500">
            {connected.length} device{connected.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">
          <RefreshCw className="w-4 h-4 animate-spin inline mr-1" />Loading…
        </div>
      ) : isUplink ? (
        <div className="p-5 space-y-3">
          <div className="flex items-start gap-2.5">
            <Link2 className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm">
              <div className="font-medium text-gray-800 dark:text-slate-200">This looks like an uplink / trunk port</div>
              <p className="text-gray-500 dark:text-slate-400 mt-0.5">
                {data?.reason}. The {data?.mac_count} MAC address{data?.mac_count !== 1 ? 'es' : ''} learned here are
                reachable <em>through</em> this port, not physically connected to it.
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowMacTable(v => !v)}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            {showMacTable ? 'Hide' : 'View'} MAC table ({data?.mac_count})
          </button>
          {showMacTable && (
            macTable
              ? <div className="-mx-5 -mb-5 border-t border-gray-100 dark:border-slate-700/60">
                  <div className="px-5 py-2 text-xs text-gray-400 dark:text-slate-500 bg-gray-50 dark:bg-slate-800/40">
                    Reachable via this port — not necessarily physically connected.
                  </div>
                  <PortClientRows clients={macTable.clients} />
                </div>
              : <div className="text-xs text-gray-400"><RefreshCw className="w-3 h-3 animate-spin inline mr-1" />Loading…</div>
          )}
        </div>
      ) : connected.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">
          No clients currently connected to this port.
        </div>
      ) : (
        <PortClientRows clients={connected} />
      )}
    </div>
  );
}

export default function SwitchPortDiagram({ deviceId, deviceName, autoOpenBridge, onBridgeOpened }: Props) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [selectedPorts, setSelectedPorts] = useState<Set<string>>(new Set());
  const [hoveredPort, setHoveredPort] = useState<string | null>(null);
  const [editingPort, setEditingPort] = useState<SwitchPort | null>(null);
  const [editingBridge, setEditingBridge] = useState<SwitchPort | null>(null);
  const [bridgeError, setBridgeError] = useState('');
  const [trafficRange, setTrafficRange] = useState('1h');
  const [showCreateTrunkModal, setShowCreateTrunkModal] = useState(false);
  const [editingBond, setEditingBond] = useState<SwitchPort | null>(null);
  const [confirmDestroyBond, setConfirmDestroyBond] = useState<string | null>(null);
  const [guardNotice, setGuardNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  // Predicted lockout (409 + verdict) and the retry that re-sends with confirm_lockout.
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);
  const [editForm, setEditForm] = useState<PortEditForm>({
    disabled: false,
    comment: '',
    mtu: 1500,
    poe_out: '',
    fec_mode: '',
    tx_flow_control: '',
    rx_flow_control: '',
    auto_negotiation: null,
    speed: '',
    vlan_mode: 'none',
    pvid: 1,
    tagged_vlans: '',
  });
  const [saveError, setSaveError] = useState('');
  const [bondError, setBondError] = useState('');
  const [createTrunkForm, setCreateTrunkForm] = useState<CreateTrunkForm>({
    name: '',
    mode: '802.3ad',
    lacp_rate: 'slow',
    transmit_hash_policy: '',
    mtu: '',
    min_links: '',
  });
  const [bondEditForm, setBondEditForm] = useState<BondEditForm>({
    mode: '802.3ad',
    lacp_rate: 'slow',
    transmit_hash_policy: '',
    mtu: '',
    min_links: '',
    members: [],
  });

  const { data, isLoading } = useQuery({
    queryKey: ['ports', deviceId],
    queryFn: () => devicesApi.getPorts(deviceId).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: poeMetrics } = useQuery({
    queryKey: ['device-poe', deviceId],
    queryFn: () => metricsApi.devicePoe(deviceId).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const poeWattsMap = Object.fromEntries(
    (poeMetrics?.ports ?? []).map(p => [p.port, p.watts])
  );

  // Auto-open bridge config panel when navigated from the VLANs tab warning
  useEffect(() => {
    if (!autoOpenBridge || !data?.ports) return;
    const bridgePort = data.ports.find((p) => p.name === autoOpenBridge);
    if (bridgePort) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBridgeError('');
      setLockout(null);
      setEditingBridge(bridgePort);
      onBridgeOpened?.();
    }
  }, [autoOpenBridge, data?.ports]);

  const updateInterfaceMutation = useMutation({
    mutationFn: ({ name, updates }: { name: string; updates: Record<string, unknown> }) =>
      devicesApi.updateInterface(deviceId, name, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ports', deviceId] });
      queryClient.invalidateQueries({ queryKey: ['interfaces', deviceId] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg || 'Failed to update interface');
    },
  });

  const updateVlanMutation = useMutation({
    mutationFn: ({ name, data, confirm }: { name: string; data: { pvid?: number; tagged_vlans?: number[]; untagged_vlans?: number[] }; confirm?: boolean }) =>
      devicesApi.configurePortVlan(deviceId, name, confirm ? { ...data, confirm_lockout: true } : data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ports', deviceId] });
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => updateVlanMutation.mutate({ ...vars, confirm: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg || 'Failed to apply VLAN config');
    },
  });

  const createBondMutation = useMutation({
    mutationFn: (d: { name: string; mode: string; slaves: string[]; lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number; confirm_lockout?: boolean }) =>
      devicesApi.createBond(deviceId, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ports', deviceId] });
      setShowCreateTrunkModal(false);
      setSelectedPorts(new Set());
      setBondError('');
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => createBondMutation.mutate({ ...vars, confirm_lockout: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBondError(msg || 'Failed to create bond');
    },
  });

  const updateBondMutation = useMutation({
    mutationFn: ({ name, d }: { name: string; d: { mode: string; slaves: string[]; lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number } }) =>
      devicesApi.updateBond(deviceId, name, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ports', deviceId] });
      setEditingBond(null);
      setBondError('');
      setLockout(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBondError(msg || 'Failed to update bond');
    },
  });

  const deleteBondMutation = useMutation({
    mutationFn: ({ name, confirm = false }: { name: string; confirm?: boolean }) =>
      devicesApi.deleteBond(deviceId, name, confirm),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['ports', deviceId] });
      setEditingBond(null);
      setConfirmDestroyBond(null);
      setBondError('');
      setLockout(null);
      // Report what the safety net did — especially "the device is restoring itself".
      const notice = guardOutcomeMessage((res?.data as { guard?: GuardResult })?.guard);
      if (notice) {
        setGuardNotice(notice);
        if (notice.tone === 'ok') setTimeout(() => setGuardNotice(null), 6000);
      }
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => deleteBondMutation.mutate({ name: vars.name, confirm: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBondError(msg || 'Failed to delete bond');
    },
  });

  const setBridgeVlanFilteringMutation = useMutation({
    mutationFn: ({ name, enabled, confirm = false }: { name: string; enabled: boolean; confirm?: boolean }) =>
      devicesApi.setBridgeVlanFiltering(deviceId, name, enabled, confirm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ports', deviceId] });
      setBridgeError('');
      setLockout(null);
      // Update editingBridge locally so the toggle reflects the new state immediately
      setEditingBridge((b) => b ? {
        ...b,
        config_json: { ...(b.config_json ?? {}), 'vlan-filtering': setBridgeVlanFilteringMutation.variables?.enabled ? 'true' : 'false' },
      } : null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({
          verdict,
          retry: () => setBridgeVlanFilteringMutation.mutate({ ...vars, confirm: true }),
        });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBridgeError(msg || 'Failed to update VLAN filtering');
    },
  });

  const ports: SwitchPort[] = data?.ports ?? [];
  const vlans: Vlan[] = data?.vlans ?? [];

  const isBridge = (p: SwitchPort) => p.type === 'bridge';

  const typeOrder = (p: SwitchPort) =>
    p.name.startsWith('ether') ? 0 : isBridge(p) ? 2 : 1;

  const sortedPorts = [...ports].sort((a, b) => {
    const aNum = parseInt(a.name.replace(/\D/g, '') || '0', 10);
    const bNum = parseInt(b.name.replace(/\D/g, '') || '0', 10);
    const aType = typeOrder(a);
    const bType = typeOrder(b);
    if (aType !== bType) return aType - bType;
    return aNum - bNum;
  });

  const isBond = (p: SwitchPort) => p.type === 'bond';
  const physicalPorts = sortedPorts.filter((p) => !isBridge(p) && !isBond(p));
  const bridgePorts   = sortedPorts.filter((p) => isBridge(p));
  const bondPorts     = sortedPorts.filter((p) => isBond(p));

  // Map each slave port name → its bond interface name
  const bondMemberMap = new Map<string, string>();
  bondPorts.forEach(b => {
    const slaves = (b.config_json?.slaves ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    slaves.forEach((s: string) => bondMemberMap.set(s, b.name));
  });

  const etherPorts = physicalPorts.filter((p) => p.name.startsWith('ether'));
  const sfpPorts   = physicalPorts.filter((p) => !p.name.startsWith('ether'));
  const { cages: qsfpCages, individual: individualSfpPorts } = groupQsfpCages(sfpPorts);

  const togglePort = (name: string, e: React.MouseEvent) => {
    setSelectedPorts((prev) => {
      const next = new Set(prev);
      if (e.shiftKey) {
        if (next.has(name)) next.delete(name);
        else next.add(name);
      } else {
        if (next.size === 1 && next.has(name)) next.clear();
        else { next.clear(); next.add(name); }
      }
      return next;
    });
  };

  const openEditPanel = (port: SwitchPort) => {
    if (isBridge(port)) {
      setBridgeError('');
      setLockout(null);
      setEditingBridge(port);
      return;
    }
    if (isBond(port)) {
      const slaves = (port.config_json?.slaves ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
      setBondEditForm({
        mode: (port.config_json?.mode ?? '802.3ad') as BondEditForm['mode'],
        lacp_rate: (port.config_json?.['lacp-rate'] ?? 'slow') as 'slow' | 'fast',
        transmit_hash_policy: (port.config_json?.['transmit-hash-policy'] ?? '') as BondEditForm['transmit_hash_policy'],
        mtu: port.mtu ? String(port.mtu) : '',
        min_links: port.config_json?.['min-links'] ? String(port.config_json['min-links']) : '',
        members: slaves,
      });
      setBondError('');
      setLockout(null);
      setEditingBond(port);
      return;
    }
    setSaveError('');
    const bridgePvid = port.bridgeInfo?.pvid ?? 1;
    const bridgeTagged = port.bridgeInfo?.tagged ?? false;
    setEditingPort(port);
    setEditForm({
      disabled: port.disabled,
      comment: port.comment || '',
      mtu: port.mtu || 1500,
      poe_out: '',
      fec_mode: '',
      tx_flow_control: '',
      rx_flow_control: '',
      auto_negotiation: null,
      speed: '',
      vlan_mode: bridgeTagged ? 'trunk' : bridgePvid > 1 ? 'access' : 'none',
      pvid: bridgePvid,
      // Prefill from the port's actual tagged membership so opening the dialog and
      // saving does not silently strip the trunk's VLANs.
      tagged_vlans: (port.bridgeInfo?.tagged_vlan_ids ?? []).join(','),
    });
  };

  const handleSave = async () => {
    if (!editingPort) return;
    setSaveError('');

    const ifaceUpdates: Record<string, unknown> = {
      disabled: editForm.disabled,
      comment: editForm.comment,
      mtu: editForm.mtu,
    };
    if (editForm.poe_out) ifaceUpdates.poe_out = editForm.poe_out;
    if (editForm.fec_mode) ifaceUpdates.fec_mode = editForm.fec_mode;
    if (editForm.tx_flow_control || editForm.rx_flow_control) {
      ifaceUpdates.tx_flow_control = editForm.tx_flow_control || 'off';
      ifaceUpdates.rx_flow_control = editForm.rx_flow_control || 'off';
    }
    if (editForm.auto_negotiation !== null) {
      ifaceUpdates.auto_negotiation = editForm.auto_negotiation;
      if (!editForm.auto_negotiation && editForm.speed) {
        ifaceUpdates.speed = editForm.speed;
      }
    }

    await updateInterfaceMutation.mutateAsync({ name: editingPort.name, updates: ifaceUpdates });

    if (editForm.vlan_mode !== 'none') {
      const taggedList = editForm.tagged_vlans
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0 && n <= 4094);

      const vlanData = editForm.vlan_mode === 'access'
        ? { pvid: editForm.pvid, untagged_vlans: [editForm.pvid], tagged_vlans: [] }
        : { pvid: editForm.pvid, tagged_vlans: taggedList, untagged_vlans: [] };

      await updateVlanMutation.mutateAsync({ name: editingPort.name, data: vlanData });
    }

    if (!updateInterfaceMutation.isError && !updateVlanMutation.isError) {
      setEditingPort(null);
    }
  };

  const isPending = updateInterfaceMutation.isPending || updateVlanMutation.isPending;

  const PORT_W = 32;
  const PORT_H = 36;
  const GAP = 4;
  const PAD = 12;
  const ROW_GAP = 6;
  // Use two staggered rows only for larger switches (>8 ports); single row otherwise
  const doubleRow = etherPorts.length > 8;
  const topRowPorts = doubleRow ? etherPorts.filter((_, i) => i % 2 === 0) : etherPorts;
  const bottomRowPorts = doubleRow ? etherPorts.filter((_, i) => i % 2 === 1) : [];

  // Ether section width (including left pad, excluding right pad — right pad shared with SFP divider)
  const etherCols = topRowPorts.length;
  const etherSectionW = PAD + etherCols * (PORT_W + GAP);

  // SFP section: individual (non-breakout) SFP ports
  const sfpDivider = individualSfpPorts.length > 0 ? 20 : 0;
  const sfpSectionW = individualSfpPorts.length > 0 ? individualSfpPorts.length * (PORT_W + GAP) + PAD : 0;

  // QSFP cage section — each cage renders as a grouped block
  const CAGE_LABEL_H = 11; // height of cage name label inside cage rect
  const LANE_W = 20;
  const LANE_GAP = 3;
  const CAGE_PAD_X = 3;
  const CAGE_LANE_H = PORT_H - CAGE_LABEL_H - 2; // lane rect height inside cage
  const getCageW = (n: number) => n * (LANE_W + LANE_GAP) - LANE_GAP + 2 * CAGE_PAD_X;
  const qsfpDivider = qsfpCages.length > 0 ? 20 : 0;
  const qsfpSectionW = qsfpCages.length > 0
    ? PAD + qsfpCages.reduce((acc, c) => acc + getCageW(c.singlePort ? 4 : c.lanes.length) + GAP, -GAP)
    : 0;

  // Bridge section: divider gap + ports + right pad
  const bridgeDivider = bridgePorts.length > 0 ? 20 : 0;
  const bridgeSectionW = bridgePorts.length > 0 ? bridgePorts.length * (PORT_W + GAP) + PAD : 0;

  // Bond section: divider gap + bond virtual ports + right pad
  const bondDivider = bondPorts.length > 0 ? 20 : 0;
  const bondSectionW = bondPorts.length > 0 ? bondPorts.length * (PORT_W + GAP) + PAD : 0;

  const chassisW = Math.max(
    etherSectionW + sfpDivider + sfpSectionW + qsfpDivider + qsfpSectionW + bridgeDivider + bridgeSectionW + bondDivider + bondSectionW,
    200,
  );
  const chassisH = (doubleRow ? PORT_H * 2 + ROW_GAP : PORT_H) + PAD * 2 + 20;

  const sfpStartX = etherSectionW + sfpDivider;
  const qsfpStartX = etherSectionW + sfpDivider + sfpSectionW + qsfpDivider;
  const bridgeStartX = qsfpStartX + qsfpSectionW + bridgeDivider;
  const bondStartX = bridgeStartX + bridgeSectionW + bondDivider;
  const topRowY = 20;
  const bottomRowY = 20 + PORT_H + ROW_GAP;
  // SFP, QSFP and bridge: center within the ether port area height
  const etherAreaH = doubleRow ? PORT_H * 2 + ROW_GAP : PORT_H;
  const sfpY = topRowY + Math.round((etherAreaH - PORT_H) / 2);
  const bridgeY = sfpY;

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-gray-400">Loading ports...</div>;
  }

  if (ports.length === 0) {
    return (
      <div className="card p-8 text-center text-gray-400 dark:text-slate-500">
        No switchable ports found for this device.
        <br />
        <span className="text-sm">Ports appear after the device is synced.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Selection bar */}
      {selectedPorts.size > 0 && (() => {
        const singlePort = selectedPorts.size === 1 ? ports.find(p => p.name === Array.from(selectedPorts)[0]) : null;
        const selArr = Array.from(selectedPorts).map(n => ports.find(p => p.name === n)).filter((p): p is SwitchPort => !!p);
        const allEligible = selArr.every(p => !isBridge(p) && !isBond(p) && !bondMemberMap.has(p.name));
        return (
          <div style={{
            background: 'var(--accent-soft)', border: '1px solid var(--accent)',
            borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)', flexShrink: 0, boxShadow: '0 0 0 2px var(--accent)33, 0 0 8px var(--accent)88' }} />
            <span className="mono text-[12px]" style={{ color: 'var(--accent)' }}>
              {selectedPorts.size === 1 ? Array.from(selectedPorts)[0] : `${selectedPorts.size} ports`}
            </span>
            {singlePort && (
              <span className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
                selected{singlePort.speed ? ` · ${singlePort.speed}` : ''}{singlePort.mtu ? ` · ${singlePort.mtu} MTU` : ''}{singlePort.running ? ' · link-ok' : ' · link-down'}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              className="text-[11px]"
              style={{ padding: '5px 10px', borderRadius: 5, background: 'transparent', color: 'var(--ink-3)', border: '1px solid var(--line)' }}
              onClick={() => setSelectedPorts(new Set())}
            >Clear</button>
            {canWrite && singlePort && (
              <button
                className="btn-primary text-[11px]"
                style={{ padding: '5px 10px' }}
                onClick={() => openEditPanel(singlePort)}
              >Configure</button>
            )}
            {canWrite && selectedPorts.size >= 2 && allEligible && (
              <button
                className="btn-secondary text-[11px] flex items-center gap-[6px]"
                style={{ padding: '5px 10px' }}
                onClick={() => {
                  setCreateTrunkForm({ name: `bond${bondPorts.length + 1}`, mode: '802.3ad', lacp_rate: 'slow', transmit_hash_policy: '', mtu: '', min_links: '' });
                  setBondError('');
      setLockout(null);
                  setShowCreateTrunkModal(true);
                }}
              >
                <Link2 className="w-3 h-3" /> Create Trunk
              </button>
            )}
          </div>
        );
      })()}

      {/* Faceplate card */}
      <div className="card" style={{ padding: '22px 26px', position: 'relative', overflow: 'hidden' }}>
        {/* Pinstripe overlay */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 9px, rgba(255,255,255,0.015) 9px, rgba(255,255,255,0.015) 10px)' }} />
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                Switch faceplate · {ports.length} ports
              </div>
              <div className="mono text-[11px] mt-[2px]" style={{ color: 'var(--ink-3)' }}>
                click to select · shift for multi · double-click to configure
              </div>
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              {([['up', 'var(--accent)', ports.filter(p => !p.disabled && p.running).length], ['down', 'var(--bad)', ports.filter(p => !p.disabled && !p.running).length], ['disabled', 'var(--ink-4)', ports.filter(p => p.disabled).length], ['selected', 'var(--accent)', selectedPorts.size]] as [string,string,number][]).map(([l, c, n]) => (
                <span key={l} className="mono text-[11px]" style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--ink-3)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: c, opacity: l === 'disabled' ? 0.4 : 1, flexShrink: 0 }} />
                  {l} <span className="num-tab" style={{ color: 'var(--ink-2)' }}>{n}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Rack unit */}
          <div style={{
            background: 'linear-gradient(180deg, var(--faceplate-from), var(--faceplate-to))',
            border: '1px solid var(--faceplate-border)', borderRadius: 8, padding: '22px 26px',
            display: 'flex', gap: 30, alignItems: 'center', overflowX: 'auto',
            boxShadow: 'inset 0 0 0 2px var(--faceplate-inset), inset 0 1px 0 rgba(255,255,255,0.02)',
          }}>
            {/* ETH group */}
            {etherPorts.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.1em' }}>ETH</div>
                {doubleRow ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {topRowPorts.map(port => (
                        <PortTile key={port.name} port={port} selected={selectedPorts.has(port.name)} hovered={hoveredPort === port.name} isMember={bondMemberMap.has(port.name)} watts={poeWattsMap[port.name]} onClick={e => togglePort(port.name, e)} onMouseEnter={() => setHoveredPort(port.name)} onMouseLeave={() => setHoveredPort(null)} onDoubleClick={() => canWrite && openEditPanel(port)} />
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {bottomRowPorts.map(port => (
                        <PortTile key={port.name} port={port} selected={selectedPorts.has(port.name)} hovered={hoveredPort === port.name} isMember={bondMemberMap.has(port.name)} watts={poeWattsMap[port.name]} onClick={e => togglePort(port.name, e)} onMouseEnter={() => setHoveredPort(port.name)} onMouseLeave={() => setHoveredPort(null)} onDoubleClick={() => canWrite && openEditPanel(port)} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {topRowPorts.map(port => (
                      <PortTile key={port.name} port={port} selected={selectedPorts.has(port.name)} hovered={hoveredPort === port.name} isMember={bondMemberMap.has(port.name)} watts={poeWattsMap[port.name]} onClick={e => togglePort(port.name, e)} onMouseEnter={() => setHoveredPort(port.name)} onMouseLeave={() => setHoveredPort(null)} onDoubleClick={() => canWrite && openEditPanel(port)} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SFP group */}
            {individualSfpPorts.length > 0 && (
              <div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.1em', marginBottom: 6 }}>
                  SFP · 1–{individualSfpPorts.length}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: individualSfpPorts.length * 52 }}>
                  {individualSfpPorts.map(port => (
                    <PortTile key={port.name} port={port} selected={selectedPorts.has(port.name)} hovered={hoveredPort === port.name} watts={poeWattsMap[port.name]} onClick={e => togglePort(port.name, e)} onMouseEnter={() => setHoveredPort(port.name)} onMouseLeave={() => setHoveredPort(null)} onDoubleClick={() => canWrite && openEditPanel(port)} />
                  ))}
                </div>
              </div>
            )}

            {/* QSFP cages */}
            {qsfpCages.map(cage => {
              const isSingleMode = !!cage.singlePort;
              const laneCount = isSingleMode ? 4 : cage.lanes.length;
              const runningLanes = cage.lanes.filter(p => p.running && !p.disabled).length;
              const isSingleCable = !isSingleMode && runningLanes === 1;
              const refPort = cage.singlePort ?? cage.lanes[0];
              return (
                <div key={cage.key}>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.1em', marginBottom: 6 }}>{cage.label}</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {Array.from({ length: laneCount }, (_, li) => {
                      const lane = isSingleMode ? cage.singlePort! : cage.lanes[li];
                      const visualPort: SwitchPort = (isSingleMode || isSingleCable) ? { ...refPort, running: refPort.running, disabled: refPort.disabled } : lane;
                      return (
                        <PortTile key={li} port={visualPort} selected={selectedPorts.has(lane.name)} hovered={hoveredPort === lane.name} watts={poeWattsMap[lane.name]} onClick={e => togglePort(lane.name, e)} onMouseEnter={() => setHoveredPort(lane.name)} onMouseLeave={() => setHoveredPort(null)} onDoubleClick={() => canWrite && openEditPanel(lane)} />
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Bridge group */}
            {bridgePorts.length > 0 && (
              <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.1em' }}>BRIDGE</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {bridgePorts.map(port => (
                    <PortTile key={port.name} port={port} selected={selectedPorts.has(port.name)} hovered={hoveredPort === port.name} watts={poeWattsMap[port.name]} onClick={e => togglePort(port.name, e)} onMouseEnter={() => setHoveredPort(port.name)} onMouseLeave={() => setHoveredPort(null)} onDoubleClick={() => canWrite && openEditPanel(port)} />
                  ))}
                </div>
              </div>
            )}

            {/* Bond group */}
            {bondPorts.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.1em' }}>BOND</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {bondPorts.map(port => (
                    <PortTile key={port.name} port={port} selected={selectedPorts.has(port.name)} hovered={hoveredPort === port.name} watts={poeWattsMap[port.name]} onClick={e => togglePort(port.name, e)} onMouseEnter={() => setHoveredPort(port.name)} onMouseLeave={() => setHoveredPort(null)} onDoubleClick={() => canWrite && openEditPanel(port)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Port throughput + info — shown when exactly one port is selected */}
      {selectedPorts.size === 1 && (() => {
        const portName = Array.from(selectedPorts)[0];
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
              <div className="md:col-span-1">
                <PortTrafficGraph
                  deviceId={deviceId}
                  portName={portName}
                  range={trafficRange}
                  onRangeChange={setTrafficRange}
                />
              </div>
              <div className="md:col-span-1">
                <PortPacketGraph
                  deviceId={deviceId}
                  portName={portName}
                  range={trafficRange}
                />
              </div>
              <div className="md:col-span-1">
                <PortInfoCard deviceId={deviceId} portName={portName} />
              </div>
            </div>
            <PortClientsCard deviceId={deviceId} portName={portName} />
          </div>
        );
      })()}

      {/* Port table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                {['PORT', 'STATUS', 'SPEED', 'MTU', 'PVID', 'MAC', 'COMMENT', ''].map((h, i) => (
                  <th key={i} className="table-header px-4 py-[10px] text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedPorts.map((port, i) => {
                const state = portState(port);
                const stateColor = state === 'up' ? 'var(--good)' : state === 'down' ? 'var(--bad)' : 'var(--ink-4)';
                const isSelected = selectedPorts.has(port.name);
                return (
                  <tr
                    key={port.name}
                    className="cursor-pointer transition-colors"
                    style={{
                      borderBottom: i < sortedPorts.length - 1 ? '1px solid var(--line-soft)' : 'none',
                      background: isSelected ? 'var(--accent-soft)' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = isSelected ? 'var(--accent-soft)' : 'transparent'; }}
                    onClick={(e) => togglePort(port.name, e)}
                  >
                    <td className="px-4 py-[10px]">
                      <div className="flex items-center gap-[6px]">
                        <span className="mono text-[12px] font-medium" style={{ color: 'var(--ink)' }}>{port.name}</span>
                        {bondMemberMap.has(port.name) && (
                          <span className="mono text-[9.5px] px-[5px] py-[2px] rounded" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>
                            {bondMemberMap.get(port.name)}
                          </span>
                        )}
                        {isBond(port) && (
                          <span className="mono text-[9.5px] px-[5px] py-[2px] rounded" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>BOND</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-[10px]">
                      <span className="inline-flex items-center gap-[5px] mono text-[11px] font-medium" style={{ color: stateColor }}>
                        <span style={{ width: 6, height: 6, borderRadius: 999, background: stateColor, flexShrink: 0 }} />
                        {port.disabled ? 'Disabled' : port.running ? 'Up' : 'Down'}
                      </span>
                    </td>
                    <td className="px-4 py-[10px]"><span className="mono text-[11.5px]" style={{ color: 'var(--ink-3)' }}>{port.speed || '—'}</span></td>
                    <td className="px-4 py-[10px]"><span className="mono num-tab text-[11.5px]" style={{ color: 'var(--ink-3)' }}>{port.mtu || '—'}</span></td>
                    <td className="px-4 py-[10px]"><span className="mono num-tab text-[11.5px]" style={{ color: 'var(--ink-3)' }}>{port.bridgeInfo?.pvid ?? '—'}</span></td>
                    <td className="px-4 py-[10px]"><span className="mono text-[11px]" style={{ color: 'var(--ink-4)' }}>{port.mac_address || '—'}</span></td>
                    <td className="px-4 py-[10px]"><span className="text-[12px]" style={{ color: 'var(--ink-3)' }}>{port.comment || '—'}</span></td>
                    <td className="px-4 py-[10px]">
                      {canWrite && (
                        <button
                          className="p-1 rounded transition-colors"
                          style={{ color: 'var(--ink-4)' }}
                          onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                          onMouseLeave={e => (e.currentTarget.style.color = 'var(--ink-4)')}
                          onClick={(e) => { e.stopPropagation(); openEditPanel(port); }}
                          title="Configure"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Port config modal */}
      {editingPort && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
              <h3 className="font-semibold text-gray-900 dark:text-white">
                Configure {editingPort.name}
              </h3>
              <button onClick={() => setEditingPort(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* Basic settings */}
              <div>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  Basic
                </h4>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Port Enabled</label>
                    <button
                      onClick={() => setEditForm((f) => ({ ...f, disabled: !f.disabled }))}
                      className={clsx(
                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                        !editForm.disabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                      )}
                    >
                      <span className={clsx(
                        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                        !editForm.disabled ? 'translate-x-6' : 'translate-x-1'
                      )} />
                    </button>
                  </div>

                  <div>
                    <label className="label">Description / Comment</label>
                    <input
                      className="input"
                      value={editForm.comment}
                      onChange={(e) => setEditForm((f) => ({ ...f, comment: e.target.value }))}
                      placeholder="Port description..."
                    />
                  </div>

                  <div>
                    <label className="label">MTU</label>
                    <input
                      type="number"
                      className="input"
                      value={editForm.mtu}
                      onChange={(e) => setEditForm((f) => ({ ...f, mtu: parseInt(e.target.value) || 1500 }))}
                      min={576}
                      max={9216}
                      placeholder="1500"
                    />
                    <p className="text-xs text-gray-400 mt-1">Standard: 1500 · Jumbo frames: 9000</p>
                  </div>
                </div>
              </div>

              {/* PoE */}
              <div>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  PoE Out (Ethernet only)
                </h4>
                <select
                  className="input"
                  value={editForm.poe_out}
                  onChange={(e) => setEditForm((f) => ({ ...f, poe_out: e.target.value as PortEditForm['poe_out'] }))}
                >
                  <option value="">— No change —</option>
                  <option value="auto-on">Auto-on (802.3af/at detection)</option>
                  <option value="forced-on">Forced-on (always supply power)</option>
                  <option value="off">Off (disabled)</option>
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  Only applies to PoE-capable interfaces. Ignored if not supported.
                </p>
              </div>

              {/* Link / Physical */}
              <div>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  Link Settings
                </h4>
                <div className="space-y-3">
                  {/* Auto-negotiation */}
                  <div>
                    <label className="label">Auto-Negotiation</label>
                    <select
                      className="input"
                      value={editForm.auto_negotiation === null ? '' : editForm.auto_negotiation ? 'yes' : 'no'}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEditForm((f) => ({
                          ...f,
                          auto_negotiation: v === '' ? null : v === 'yes',
                          speed: v === 'yes' ? '' : f.speed,
                        }));
                      }}
                    >
                      <option value="">— No change —</option>
                      <option value="yes">Enabled</option>
                      <option value="no">Disabled (manual speed)</option>
                    </select>
                  </div>
                  {editForm.auto_negotiation === false && (
                    <div>
                      <label className="label">Speed</label>
                      <select
                        className="input"
                        value={editForm.speed}
                        onChange={(e) => setEditForm((f) => ({ ...f, speed: e.target.value }))}
                      >
                        <option value="">— Select speed —</option>
                        <option value="10Mbps">10 Mbps</option>
                        <option value="100Mbps">100 Mbps</option>
                        <option value="1Gbps">1 Gbps</option>
                        <option value="2.5Gbps">2.5 Gbps</option>
                        <option value="5Gbps">5 Gbps</option>
                        <option value="10Gbps">10 Gbps</option>
                        <option value="25Gbps">25 Gbps</option>
                        <option value="40Gbps">40 Gbps</option>
                        <option value="100Gbps">100 Gbps</option>
                      </select>
                    </div>
                  )}
                  {/* Flow Control */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">TX Flow Control</label>
                      <select
                        className="input"
                        value={editForm.tx_flow_control}
                        onChange={(e) => setEditForm((f) => ({ ...f, tx_flow_control: e.target.value as PortEditForm['tx_flow_control'] }))}
                      >
                        <option value="">— No change —</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                        <option value="auto">Auto</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">RX Flow Control</label>
                      <select
                        className="input"
                        value={editForm.rx_flow_control}
                        onChange={(e) => setEditForm((f) => ({ ...f, rx_flow_control: e.target.value as PortEditForm['rx_flow_control'] }))}
                      >
                        <option value="">— No change —</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                        <option value="auto">Auto</option>
                      </select>
                    </div>
                  </div>
                  {/* FEC Mode */}
                  <div>
                    <label className="label">FEC Mode</label>
                    <select
                      className="input"
                      value={editForm.fec_mode}
                      onChange={(e) => setEditForm((f) => ({ ...f, fec_mode: e.target.value as PortEditForm['fec_mode'] }))}
                    >
                      <option value="">— No change —</option>
                      <option value="clause-74">Clause 74 (FireCode)</option>
                      <option value="clause-91">Clause 91 (Reed-Solomon)</option>
                      <option value="off">Off</option>
                    </select>
                    <p className="text-xs text-gray-400 mt-1">Only applies to ports that support FEC.</p>
                  </div>
                </div>
              </div>

              {/* VLAN */}
              <div>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  VLAN Configuration
                </h4>
                {vlans.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-slate-500">
                    No VLANs configured on this device. Create VLANs in the VLANs tab first.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="label">Mode</label>
                      <select
                        className="input"
                        value={editForm.vlan_mode}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            vlan_mode: e.target.value as PortEditForm['vlan_mode'],
                          }))
                        }
                      >
                        <option value="none">— No change —</option>
                        <option value="access">Access (single untagged VLAN)</option>
                        <option value="trunk">Trunk (tagged VLANs)</option>
                      </select>
                    </div>

                    {editForm.vlan_mode === 'access' && (
                      <div>
                        <label className="label">Access VLAN (PVID)</label>
                        <select
                          className="input"
                          value={editForm.pvid}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, pvid: parseInt(e.target.value) }))
                          }
                        >
                          {vlans.map((v) => (
                            <option key={v.vlan_id} value={v.vlan_id}>
                              {v.vlan_id} — {v.name || `VLAN ${v.vlan_id}`}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-gray-400 mt-1">
                          Port will be untagged member of this VLAN
                        </p>
                      </div>
                    )}

                    {editForm.vlan_mode === 'trunk' && (
                      <>
                        <div>
                          <label className="label">Native VLAN (PVID — untagged)</label>
                          <select
                            className="input"
                            value={editForm.pvid}
                            onChange={(e) =>
                              setEditForm((f) => ({ ...f, pvid: parseInt(e.target.value) }))
                            }
                          >
                            <option value={1}>1 (default)</option>
                            {vlans.map((v) => (
                              <option key={v.vlan_id} value={v.vlan_id}>
                                {v.vlan_id} — {v.name || `VLAN ${v.vlan_id}`}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="label">Tagged VLANs (comma-separated IDs)</label>
                          <input
                            className="input font-mono"
                            value={editForm.tagged_vlans}
                            onChange={(e) =>
                              setEditForm((f) => ({ ...f, tagged_vlans: e.target.value }))
                            }
                            placeholder="e.g. 10, 20, 30"
                          />
                          <div className="text-xs text-gray-400 mt-1">
                            Available VLANs: {vlans.map((v) => v.vlan_id).join(', ')}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {saveError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button onClick={() => setEditingPort(null)} className="btn-secondary">Cancel</button>
                <button
                  onClick={handleSave}
                  disabled={isPending}
                  className="btn-primary flex items-center gap-2"
                >
                  {isPending ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Trunk modal */}
      {showCreateTrunkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="card w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
              <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Link2 className="w-4 h-4 text-amber-500" />
                Create Trunk / Bond
              </h3>
              <button onClick={() => setShowCreateTrunkModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="label">Bond Interface Name</label>
                <input
                  className="input font-mono"
                  value={createTrunkForm.name}
                  onChange={(e) => setCreateTrunkForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="bond1"
                />
              </div>

              <div>
                <label className="label">Member Ports</label>
                <div className="flex flex-wrap gap-1.5 p-2 bg-gray-50 dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-600">
                  {Array.from(selectedPorts).map(n => (
                    <span key={n} className="px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 text-xs font-mono rounded">
                      {n}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <label className="label">Mode</label>
                <select
                  className="input"
                  value={createTrunkForm.mode}
                  onChange={(e) => setCreateTrunkForm(f => ({ ...f, mode: e.target.value as CreateTrunkForm['mode'] }))}
                >
                  <option value="802.3ad">802.3ad — LACP (dynamic link aggregation)</option>
                  <option value="balance-xor">balance-xor — Static LAG (XOR hash)</option>
                  <option value="active-backup">active-backup — Failover</option>
                </select>
              </div>

              {(createTrunkForm.mode === '802.3ad' || createTrunkForm.mode === 'balance-xor') && (
                <div>
                  <label className="label">Transmit Hash Policy</label>
                  <select
                    className="input"
                    value={createTrunkForm.transmit_hash_policy}
                    onChange={(e) => setCreateTrunkForm(f => ({ ...f, transmit_hash_policy: e.target.value as CreateTrunkForm['transmit_hash_policy'] }))}
                  >
                    <option value="">— Default (layer2) —</option>
                    <option value="layer2">layer2 (MAC-based)</option>
                    <option value="layer2+3">layer2+3 (MAC + IP)</option>
                    <option value="layer3+4">layer3+4 (IP + port)</option>
                  </select>
                </div>
              )}

              {createTrunkForm.mode === '802.3ad' && (
                <div>
                  <label className="label">LACP Rate</label>
                  <select
                    className="input"
                    value={createTrunkForm.lacp_rate}
                    onChange={(e) => setCreateTrunkForm(f => ({ ...f, lacp_rate: e.target.value as 'slow' | 'fast' }))}
                  >
                    <option value="slow">Slow (30s interval)</option>
                    <option value="fast">Fast (1s interval)</option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Min Links</label>
                  <input
                    type="number"
                    className="input"
                    value={createTrunkForm.min_links}
                    onChange={(e) => setCreateTrunkForm(f => ({ ...f, min_links: e.target.value }))}
                    placeholder="1"
                    min={1}
                  />
                  <p className="text-xs text-gray-400 mt-1">Min active members required</p>
                </div>
                <div>
                  <label className="label">MTU (optional)</label>
                  <input
                    type="number"
                    className="input"
                    value={createTrunkForm.mtu}
                    onChange={(e) => setCreateTrunkForm(f => ({ ...f, mtu: e.target.value }))}
                    placeholder="1500"
                    min={576}
                    max={9216}
                  />
                </div>
              </div>

              {bondError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600 dark:text-red-400">{bondError}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button onClick={() => setShowCreateTrunkModal(false)} className="btn-secondary">Cancel</button>
                <button
                  disabled={createBondMutation.isPending || !createTrunkForm.name}
                  className="btn-primary flex items-center gap-2"
                  onClick={() => {
                    const slaves = Array.from(selectedPorts);
                    const payload: { name: string; mode: string; slaves: string[]; lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number } = {
                      name: createTrunkForm.name,
                      mode: createTrunkForm.mode,
                      slaves,
                    };
                    if (createTrunkForm.mode === '802.3ad' && createTrunkForm.lacp_rate) payload.lacp_rate = createTrunkForm.lacp_rate;
                    if (createTrunkForm.transmit_hash_policy) payload.transmit_hash_policy = createTrunkForm.transmit_hash_policy;
                    if (createTrunkForm.mtu) payload.mtu = parseInt(createTrunkForm.mtu);
                    if (createTrunkForm.min_links) payload.min_links = parseInt(createTrunkForm.min_links);
                    createBondMutation.mutate(payload);
                  }}
                >
                  {createBondMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Create Bond
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bond edit modal */}
      {editingBond && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="card w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
              <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Link2 className="w-4 h-4 text-amber-500" />
                Edit Bond: <span className="font-mono ml-1">{editingBond.name}</span>
              </h3>
              <button onClick={() => setEditingBond(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="label">Member Ports</label>
                <div className="space-y-1.5">
                  {bondEditForm.members.map(m => (
                    <div key={m} className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-slate-800 rounded border border-gray-200 dark:border-slate-600">
                      <span className="font-mono text-sm text-gray-900 dark:text-white">{m}</span>
                      <button
                        onClick={() => setBondEditForm(f => ({ ...f, members: f.members.filter(x => x !== m) }))}
                        className="text-red-400 hover:text-red-600 p-0.5"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {bondEditForm.members.length === 0 && (
                    <p className="text-sm text-gray-400 italic">No members — bond will be empty</p>
                  )}
                </div>
                {(() => {
                  const available = physicalPorts.filter(p =>
                    !bondEditForm.members.includes(p.name) &&
                    (!bondMemberMap.has(p.name) || bondMemberMap.get(p.name) === editingBond.name)
                  );
                  if (available.length === 0) return null;
                  return (
                    <div className="mt-2">
                      <select
                        className="input"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) {
                            setBondEditForm(f => ({ ...f, members: [...f.members, e.target.value] }));
                          }
                        }}
                      >
                        <option value="">+ Add port…</option>
                        {available.map(p => (
                          <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  );
                })()}
              </div>

              <div>
                <label className="label">Mode</label>
                <select
                  className="input"
                  value={bondEditForm.mode}
                  onChange={(e) => setBondEditForm(f => ({ ...f, mode: e.target.value as BondEditForm['mode'] }))}
                >
                  <option value="802.3ad">802.3ad — LACP</option>
                  <option value="balance-xor">balance-xor — Static LAG</option>
                  <option value="active-backup">active-backup — Failover</option>
                </select>
              </div>

              {(bondEditForm.mode === '802.3ad' || bondEditForm.mode === 'balance-xor') && (
                <div>
                  <label className="label">Transmit Hash Policy</label>
                  <select
                    className="input"
                    value={bondEditForm.transmit_hash_policy}
                    onChange={(e) => setBondEditForm(f => ({ ...f, transmit_hash_policy: e.target.value as BondEditForm['transmit_hash_policy'] }))}
                  >
                    <option value="">— Default (layer2) —</option>
                    <option value="layer2">layer2</option>
                    <option value="layer2+3">layer2+3</option>
                    <option value="layer3+4">layer3+4</option>
                  </select>
                </div>
              )}

              {bondEditForm.mode === '802.3ad' && (
                <div>
                  <label className="label">LACP Rate</label>
                  <select
                    className="input"
                    value={bondEditForm.lacp_rate}
                    onChange={(e) => setBondEditForm(f => ({ ...f, lacp_rate: e.target.value as 'slow' | 'fast' }))}
                  >
                    <option value="slow">Slow (30s)</option>
                    <option value="fast">Fast (1s)</option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Min Links</label>
                  <input
                    type="number"
                    className="input"
                    value={bondEditForm.min_links}
                    onChange={(e) => setBondEditForm(f => ({ ...f, min_links: e.target.value }))}
                    placeholder="1"
                    min={1}
                  />
                </div>
                <div>
                  <label className="label">MTU (optional)</label>
                  <input
                    type="number"
                    className="input"
                    value={bondEditForm.mtu}
                    onChange={(e) => setBondEditForm(f => ({ ...f, mtu: e.target.value }))}
                    placeholder="1500"
                    min={576}
                    max={9216}
                  />
                </div>
              </div>

              {bondError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600 dark:text-red-400">{bondError}</p>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  disabled={deleteBondMutation.isPending}
                  className="btn-danger flex items-center gap-2 text-sm"
                  onClick={() => setConfirmDestroyBond(editingBond.name)}
                >
                  {deleteBondMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Destroy Bond
                </button>
                <div className="flex items-center gap-3">
                  <button onClick={() => setEditingBond(null)} className="btn-secondary">Cancel</button>
                  <button
                    disabled={updateBondMutation.isPending}
                    className="btn-primary flex items-center gap-2"
                    onClick={() => {
                      const payload: { mode: string; slaves: string[]; lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number } = {
                        mode: bondEditForm.mode,
                        slaves: bondEditForm.members,
                      };
                      if (bondEditForm.mode === '802.3ad' && bondEditForm.lacp_rate) payload.lacp_rate = bondEditForm.lacp_rate;
                      if (bondEditForm.transmit_hash_policy) payload.transmit_hash_policy = bondEditForm.transmit_hash_policy;
                      if (bondEditForm.mtu) payload.mtu = parseInt(bondEditForm.mtu);
                      if (bondEditForm.min_links) payload.min_links = parseInt(bondEditForm.min_links);
                      updateBondMutation.mutate({ name: editingBond.name, d: payload });
                    }}
                  >
                    {updateBondMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bridge config modal */}
      {editingBridge && (() => {
        const vlanFiltering =
          editingBridge.config_json?.['vlan-filtering'] === 'true' ||
          editingBridge.config_json?.['vlan-filtering'] === 'yes';
        const isPending = setBridgeVlanFilteringMutation.isPending;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="card w-full max-w-md mx-4">
              <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
                <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                  <Network className="w-4 h-4 text-blue-500" />
                  Configure {editingBridge.name}
                </h3>
                <button onClick={() => setEditingBridge(null)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-5 space-y-5">
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                    Bridge Settings
                  </h4>
                  <div className="flex items-start justify-between gap-4 p-4 rounded-lg bg-gray-50 dark:bg-slate-800/50 border border-gray-200 dark:border-slate-700">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">VLAN Filtering</p>
                      <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                        Enables VLAN-aware switching on this bridge. Required for tagged/untagged VLAN rules to be enforced on member ports.
                      </p>
                      {!vlanFiltering && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 font-medium">
                          ⚠ Currently disabled — VLAN tag rules on member ports are not enforced.
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        if (!isPending) {
                          setBridgeVlanFilteringMutation.mutate({
                            name: editingBridge.name,
                            enabled: !vlanFiltering,
                          });
                        }
                      }}
                      disabled={isPending}
                      className={clsx(
                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 mt-1',
                        vlanFiltering ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600',
                        isPending && 'opacity-60 cursor-not-allowed'
                      )}
                    >
                      <span className={clsx(
                        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                        vlanFiltering ? 'translate-x-6' : 'translate-x-1'
                      )} />
                    </button>
                  </div>
                </div>

                {bridgeError && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-600 dark:text-red-400">{bridgeError}</p>
                  </div>
                )}

                <div className="flex justify-end pt-1">
                  <button onClick={() => setEditingBridge(null)} className="btn-secondary">
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmDestroyBond && (
        <ChangeGuardDialog
          title="Destroy bond?"
          description={`Bond "${confirmDestroyBond}" will be removed and its member ports released as individual interfaces.`}
          reason={
            'If this bond carries the link this device is managed over, removing it can take the '
            + 'device offline — even if the bond itself looks unused.'
          }
          confirmLabel="Destroy bond"
          pending={deleteBondMutation.isPending}
          onConfirm={() => deleteBondMutation.mutate({ name: confirmDestroyBond })}
          onCancel={() => setConfirmDestroyBond(null)}
        />
      )}

      {lockout && (
        <LockoutVerdictDialog
          verdict={lockout.verdict}
          confirmPhrase={deviceName || 'confirm'}
          pending={
            updateVlanMutation.isPending || createBondMutation.isPending
            || deleteBondMutation.isPending || setBridgeVlanFilteringMutation.isPending
          }
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}

      {guardNotice && (
        <div
          className={clsx(
            'fixed bottom-4 right-4 z-[70] max-w-md rounded-lg border p-3 text-sm shadow-lg',
            guardNotice.tone === 'ok'
              ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
              : 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
          )}
        >
          <div className="flex items-start gap-2">
            {guardNotice.tone === 'ok'
              ? <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            <span>{guardNotice.text}</span>
            <button onClick={() => setGuardNotice(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
