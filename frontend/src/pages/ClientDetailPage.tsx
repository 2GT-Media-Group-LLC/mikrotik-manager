import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Wifi, Network, Router, Layers, Activity,
  Power, Save, Clock, ChevronRight, AlertCircle, Pencil, X, Gauge, Check,
} from 'lucide-react';
import { useCanWrite } from '../hooks/useCanWrite';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, Cell, ReferenceLine,
} from 'recharts';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import RoamingTimeline from '../components/clients/RoamingTimeline';
import { clientsApi, trafficApi, devicesApi } from '../services/api';
import { CATEGORY_META, SELECTABLE_CATEGORIES } from '../utils/clientCategories';
import type { ClientDetail } from '../services/api';
import type { SignalPoint } from '../services/api';
import clsx from 'clsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function signalColor(dbm: number | null): string {
  if (dbm === null) return 'text-gray-400 dark:text-slate-500';
  if (dbm >= -55) return 'text-green-600 dark:text-green-400';
  if (dbm >= -65) return 'text-lime-600 dark:text-lime-400';
  if (dbm >= -75) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-500 dark:text-red-400';
}

function signalLabel(dbm: number | null): string {
  if (dbm === null) return '—';
  if (dbm >= -55) return 'Excellent';
  if (dbm >= -65) return 'Good';
  if (dbm >= -75) return 'Fair';
  return 'Poor';
}

function deviceIcon(type?: string) {
  if (type === 'wireless_ap') return Wifi;
  if (type === 'switch') return Layers;
  return Router;
}

// ─── Connectivity Timeline ────────────────────────────────────────────────────

function ConnectivityTimeline({ mac }: { mac: string }) {
  const [range, setRange] = useState<'2h' | '24h' | '7d'>('24h');

  const { data: points = [], isLoading } = useQuery({
    queryKey: ['client-presence', mac, range],
    queryFn: () => clientsApi.getPresence(mac, range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const ranges = [
    { value: '2h', label: '2h' },
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
  ] as const;

  const onlineCount = points.filter(p => p.online > 0).length;
  const uptimePct = points.length > 0 ? Math.round((onlineCount / points.length) * 100) : null;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-800 dark:text-white">Connectivity</h2>
          {uptimePct !== null && (
            <span className={clsx(
              'text-xs font-medium px-1.5 py-0.5 rounded',
              uptimePct >= 90
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : uptimePct >= 70
                ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
            )}>
              {uptimePct}% uptime
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {ranges.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={clsx(
                'px-2 py-1 text-xs rounded font-medium transition-colors',
                range === r.value
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-8 bg-gray-100 dark:bg-slate-700 rounded animate-pulse" />
      ) : points.length === 0 ? (
        <div className="h-8 flex items-center justify-center text-xs text-gray-400 dark:text-slate-500 bg-gray-50 dark:bg-slate-800 rounded">
          No presence data yet — data accumulates as the client is polled
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex h-8 rounded overflow-hidden gap-px">
            {points.map((p, i) => (
              <div
                key={i}
                title={`${format(parseISO(p.time), 'MMM d HH:mm')} — ${p.online ? 'Online' : 'Offline'}`}
                className={clsx(
                  'flex-1 transition-colors',
                  p.online ? 'bg-green-500 dark:bg-green-600' : 'bg-gray-200 dark:bg-slate-700'
                )}
              />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-gray-400 dark:text-slate-500">
            <span>{points.length > 0 ? format(parseISO(points[0].time), range === '7d' ? 'MMM d' : 'HH:mm') : ''}</span>
            <span>now</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-gray-500 dark:text-slate-400">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-green-500 inline-block" />
              Online
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-gray-200 dark:bg-slate-700 inline-block" />
              Offline
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Connection Diagram ───────────────────────────────────────────────────────

function ConnectionDiagram({ client }: { client: ClientDetail }) {
  const ClientIcon = client.client_type === 'wireless' ? Wifi : Network;
  const DeviceIcon = deviceIcon(client.device_type);
  const UpstreamIcon = client.upstream_device_type ? deviceIcon(client.upstream_device_type) : Router;

  const clientName = client.custom_name || client.hostname || client.mac_address;

  return (
    <div className="card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-gray-800 dark:text-white flex items-center gap-2">
        <Activity className="w-4 h-4 text-gray-400" />
        Connection Path
      </h2>

      <div className="flex items-center gap-2 flex-wrap">
        {/* Client node */}
        <div className="flex flex-col items-center gap-1 min-w-[80px]">
          <div className={clsx(
            'w-10 h-10 rounded-xl flex items-center justify-center',
            client.active
              ? 'bg-green-100 dark:bg-green-900/30'
              : 'bg-gray-100 dark:bg-slate-700'
          )}>
            <ClientIcon className={clsx(
              'w-5 h-5',
              client.active ? 'text-green-600 dark:text-green-400' : 'text-gray-400'
            )} />
          </div>
          <span className="text-[11px] text-center text-gray-700 dark:text-slate-300 font-medium max-w-[90px] truncate">
            {clientName}
          </span>
          {client.ip_address && (
            <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500">
              {client.ip_address}
            </span>
          )}
        </div>

        {/* Arrow */}
        <ChevronRight className="w-4 h-4 text-gray-300 dark:text-slate-600 flex-shrink-0" />

        {/* Connected device (AP/switch) */}
        <div className="flex flex-col items-center gap-1 min-w-[80px]">
          <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            {/* eslint-disable-next-line react-hooks/static-components */}
            <DeviceIcon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <span className="text-[11px] text-center text-gray-700 dark:text-slate-300 font-medium max-w-[90px] truncate">
            {client.device_name || 'Unknown'}
          </span>
          {client.ssid && (
            <span className="text-[10px] text-blue-500 dark:text-blue-400 font-medium">
              {client.ssid}
            </span>
          )}
          {client.interface_name && !client.ssid && (
            <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500">
              {client.interface_name}
            </span>
          )}
        </div>

        {/* Upstream device (if known) */}
        {client.upstream_device_name && (
          <>
            <ChevronRight className="w-4 h-4 text-gray-300 dark:text-slate-600 flex-shrink-0" />
            <div className="flex flex-col items-center gap-1 min-w-[80px]">
              <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                {/* eslint-disable-next-line react-hooks/static-components */}
                <UpstreamIcon className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              </div>
              <span className="text-[11px] text-center text-gray-700 dark:text-slate-300 font-medium max-w-[90px] truncate">
                {client.upstream_device_name}
              </span>
              {client.upstream_device_ip && (
                <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500">
                  {client.upstream_device_ip}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Client Details Card ──────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-gray-100 dark:border-slate-700/50 last:border-0">
      <span className="text-xs text-gray-500 dark:text-slate-400 shrink-0 pt-0.5">{label}</span>
      <div className="text-xs text-gray-800 dark:text-slate-200 text-right">{children}</div>
    </div>
  );
}

// Quick per-client bandwidth cap: creates a RouterOS simple queue on the
// client's device targeting its IP. Mirrors the Queues tab but one-click.
function LimitBandwidth({ deviceId, ip, name }: { deviceId: number; ip: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState('10M');
  const [down, setDown] = useState('50M');
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  const apply = async () => {
    setStatus('saving'); setError('');
    try {
      await devicesApi.addQueue(deviceId, {
        name: `mm-${name}-${ip}`.slice(0, 60).replace(/[^a-zA-Z0-9._-]/g, '_'),
        target: ip,
        max_limit: `${up || '0'}/${down || '0'}`,
        comment: `Limit for ${name} (MikroTik Manager)`,
      });
      setStatus('done'); setTimeout(() => { setStatus('idle'); setOpen(false); }, 2500);
    } catch (e) {
      setStatus('error');
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to create queue');
    }
  };

  return (
    <div className="pt-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-700 dark:text-slate-300">Bandwidth limit</span>
      </div>
      {!open ? (
        <button onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-900/50 transition-colors">
          <Gauge className="w-3.5 h-3.5" /> Limit this client
        </button>
      ) : (
        <div className="space-y-2 border border-emerald-200 dark:border-emerald-800 rounded-lg p-2.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-gray-500 dark:text-slate-400">Upload
              <input className="input font-mono mt-0.5 py-1 text-xs" value={up} onChange={e => setUp(e.target.value)} placeholder="10M" /></label>
            <label className="text-[10px] text-gray-500 dark:text-slate-400">Download
              <input className="input font-mono mt-0.5 py-1 text-xs" value={down} onChange={e => setDown(e.target.value)} placeholder="50M" /></label>
          </div>
          {error && <p className="text-[10px] text-red-500">{error}</p>}
          <div className="flex items-center gap-2">
            <button onClick={apply} disabled={status === 'saving'}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {status === 'done' ? <><Check className="w-3 h-3" /> Applied</> : status === 'saving' ? 'Applying…' : 'Apply limit'}
            </button>
            <button onClick={() => { setOpen(false); setStatus('idle'); setError(''); }} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-slate-300">Cancel</button>
          </div>
          <p className="text-[10px] text-gray-400 dark:text-slate-500">Creates a simple queue on the device for <span className="font-mono">{ip}</span>. Manage it later under the device&apos;s Bandwidth tab.</p>
        </div>
      )}
    </div>
  );
}

function ClientDetailsCard({ client, canWrite }: { client: ClientDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState(client.comment || '');
  const [notesChanged, setNotesChanged] = useState(false);
  const [wolStatus, setWolStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(client.custom_name || '');

  const nameMutation = useMutation({
    mutationFn: () => clientsApi.updateHostname(client.mac_address, nameValue),
    onSuccess: () => {
      // Invalidate everywhere names are shown
      qc.invalidateQueries({ queryKey: ['client-detail', client.mac_address] });
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['wireless-clients-page'] });
      setEditingName(false);
    },
  });

  const notesMutation = useMutation({
    mutationFn: () => clientsApi.updateNotes(client.mac_address, notes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-detail', client.mac_address] });
      setNotesChanged(false);
    },
  });

  const categoryMutation = useMutation({
    mutationFn: (category: string | null) => clientsApi.updateCategory(client.mac_address, category),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-detail', client.mac_address] });
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['wireless-clients-page'] });
    },
  });

  const handleWol = async () => {
    setWolStatus('sending');
    try {
      await clientsApi.wol(client.mac_address);
      setWolStatus('sent');
      setTimeout(() => setWolStatus('idle'), 3000);
    } catch {
      setWolStatus('error');
      setTimeout(() => setWolStatus('idle'), 3000);
    }
  };

  return (
    <div className="card p-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-800 dark:text-white">Client Details</h2>

      <div className="space-y-0">
        {/* Editable name row */}
        <div className="flex items-start justify-between gap-4 py-2 border-b border-gray-100 dark:border-slate-700/50">
          <span className="text-xs text-gray-500 dark:text-slate-400 shrink-0 pt-0.5">Name</span>
          <div className="flex-1 flex items-center justify-end gap-1 min-w-0">
            {editingName ? (
              <>
                <input
                  autoFocus
                  type="text"
                  className="flex-1 min-w-0 rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs text-gray-800 dark:text-slate-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={client.hostname || 'e.g. Office Printer'}
                  value={nameValue}
                  onChange={e => setNameValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') nameMutation.mutate(); if (e.key === 'Escape') setEditingName(false); }}
                />
                <button
                  onClick={() => nameMutation.mutate()}
                  disabled={nameMutation.isPending}
                  className="p-1 rounded text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                  title="Save"
                >
                  <Save className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => { setEditingName(false); setNameValue(client.custom_name || ''); }}
                  className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700"
                  title="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-gray-800 dark:text-slate-200 truncate">
                  {client.custom_name || client.hostname || (
                    <span className="italic text-gray-400 dark:text-slate-500">No name</span>
                  )}
                  {client.custom_name && (
                    <span className="ml-1.5 text-[10px] text-blue-500">custom</span>
                  )}
                </span>
                {canWrite && (
                  <button
                    onClick={() => setEditingName(true)}
                    className="p-1 rounded text-gray-300 dark:text-slate-600 hover:text-gray-500 dark:hover:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 flex-shrink-0"
                    title="Edit name"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {nameMutation.isError && (
          <p className="text-[11px] text-red-500 pb-1">Failed to save name.</p>
        )}

        <DetailRow label="Status">
          <span className={clsx(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium',
            client.active
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
              : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
          )}>
            <span className={clsx(
              'w-1.5 h-1.5 rounded-full',
              client.active ? 'bg-green-500' : 'bg-gray-400'
            )} />
            {client.active ? 'Online' : 'Offline'}
          </span>
        </DetailRow>

        <DetailRow label="IP Address">
          <span className="font-mono">{client.ip_address || '—'}</span>
        </DetailRow>

        <DetailRow label="MAC Address">
          <span className="font-mono">{client.mac_address}</span>
        </DetailRow>

        {client.vendor && (
          <DetailRow label="Vendor">{client.vendor}</DetailRow>
        )}

        {/* Device category — auto-fingerprinted, user-overridable */}
        <DetailRow label="Device type">
          <div className="flex items-center gap-2 min-w-0">
            {canWrite ? (
              <select
                className="input py-1 text-sm w-auto max-w-[220px]"
                value={client.custom_category ?? ''}
                onChange={(e) => categoryMutation.mutate(e.target.value === '' ? null : e.target.value)}
                disabled={categoryMutation.isPending}
              >
                <option value="">
                  Automatic — {CATEGORY_META[client.auto_category ?? 'unknown']?.label ?? 'Unknown'}
                </option>
                {SELECTABLE_CATEGORIES.filter(c => c !== 'unknown').map(c => (
                  <option key={c} value={c}>{CATEGORY_META[c].label}</option>
                ))}
              </select>
            ) : (
              <span>{CATEGORY_META[client.device_category ?? 'unknown']?.label ?? 'Unknown'}</span>
            )}
            {client.custom_category && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex-shrink-0"
                title={`Auto-detected as: ${CATEGORY_META[client.auto_category ?? 'unknown']?.label ?? 'Unknown'}`}>
                manual
              </span>
            )}
            {categoryMutation.isPending && <span className="text-xs text-gray-400">saving…</span>}
          </div>
        </DetailRow>

        <DetailRow label="Type">
          <span className={clsx(
            'capitalize',
            client.client_type === 'wireless' ? 'text-purple-600 dark:text-purple-400' : 'text-blue-600 dark:text-blue-400'
          )}>
            {client.client_type || '—'}
          </span>
        </DetailRow>

        {client.signal_strength != null && (
          <DetailRow label="Signal">
            <span className={clsx('font-medium', signalColor(client.signal_strength))}>
              {client.signal_strength} dBm
              <span className="ml-1 font-normal opacity-75">({signalLabel(client.signal_strength)})</span>
            </span>
          </DetailRow>
        )}

        {client.vlan_id != null && (
          <DetailRow label="VLAN">
            <span className="font-mono">
              {client.vlan_id}
              {client.vlan_name && (
                <span className="ml-1.5 font-sans text-gray-500 dark:text-slate-400">({client.vlan_name})</span>
              )}
            </span>
          </DetailRow>
        )}

        <DetailRow label="Interface">
          <span className="font-mono">{client.interface_name || '—'}</span>
        </DetailRow>

        {client.ssid && (
          <DetailRow label="SSID">{client.ssid}</DetailRow>
        )}

        <DetailRow label="Last Seen">
          {client.last_seen
            ? formatDistanceToNow(new Date(client.last_seen), { addSuffix: true })
            : '—'}
        </DetailRow>
      </div>

      {/* Wake-on-LAN */}
      {canWrite && (
        <div className="pt-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-700 dark:text-slate-300">Wake on LAN</span>
          </div>
          <button
            onClick={handleWol}
            disabled={wolStatus === 'sending'}
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              wolStatus === 'sent'
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : wolStatus === 'error'
                ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50'
            )}
          >
            <Power className="w-3.5 h-3.5" />
            {wolStatus === 'sending' ? 'Sending…' : wolStatus === 'sent' ? 'Packet sent!' : wolStatus === 'error' ? 'Failed to send' : 'Send magic packet'}
          </button>
          <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">
            Sends a UDP broadcast magic packet to wake this client.
          </p>
        </div>
      )}

      {/* Limit bandwidth — creates a simple queue on the client's device targeting its IP */}
      {canWrite && client.ip_address && client.device_id && (
        <LimitBandwidth deviceId={client.device_id} ip={client.ip_address} name={client.custom_name || client.hostname || client.mac_address} />
      )}

      {/* Notes */}
      <div className="pt-1">
        <label className="text-xs font-medium text-gray-700 dark:text-slate-300 block mb-1.5">Notes</label>
        <textarea
          rows={3}
          readOnly={!canWrite}
          className={clsx(
            'w-full rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs text-gray-800 dark:text-slate-200 px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-300 dark:placeholder-slate-600',
            !canWrite && 'opacity-60 cursor-not-allowed'
          )}
          placeholder={canWrite ? 'Add notes about this client…' : 'No notes'}
          value={notes}
          onChange={e => { if (canWrite) { setNotes(e.target.value); setNotesChanged(true); } }}
        />
        {canWrite && notesChanged && (
          <button
            onClick={() => notesMutation.mutate()}
            disabled={notesMutation.isPending}
            className="mt-1.5 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {notesMutation.isPending ? 'Saving…' : 'Save notes'}
          </button>
        )}
        {notesMutation.isError && (
          <p className="mt-1 text-[11px] text-red-500">Failed to save notes.</p>
        )}
      </div>
    </div>
  );
}

// ─── Traffic Graph ────────────────────────────────────────────────────────────

function TrafficCard({ mac }: { mac: string }) {
  const [range, setRange] = useState<'2h' | '24h' | '7d'>('24h');

  const { data: points = [], isLoading } = useQuery({
    queryKey: ['client-traffic', mac, range],
    queryFn: () => clientsApi.getTraffic(mac, range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const ranges = [
    { value: '2h', label: '2h' },
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
  ] as const;

  const chartData = points.map(p => ({
    time: p.time,
    Upload: p.tx_bytes,
    Download: p.rx_bytes,
    label: format(parseISO(p.time), range === '7d' ? 'MMM d HH:mm' : 'HH:mm'),
  }));

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-white flex items-center gap-2">
          <Activity className="w-4 h-4 text-gray-400" />
          Wireless Usage
        </h2>
        <div className="flex gap-1">
          {ranges.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={clsx(
                'px-2 py-1 text-xs rounded font-medium transition-colors',
                range === r.value
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-48 bg-gray-100 dark:bg-slate-700/40 rounded animate-pulse" />
      ) : chartData.length === 0 ? (
        <div className="h-48 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-slate-500 text-xs bg-gray-50 dark:bg-slate-800/50 rounded">
          <Activity className="w-6 h-6 opacity-30" />
          No traffic data yet for this range
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-20" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: 'currentColor' }}
              className="text-gray-400 dark:text-slate-500"
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v) => formatBytes(v)}
              tick={{ fontSize: 10, fill: 'currentColor' }}
              className="text-gray-400 dark:text-slate-500"
              width={60}
            />
            <Tooltip
              formatter={(value: number) => [formatBytes(value), '']}
              contentStyle={{
                fontSize: '11px',
                backgroundColor: 'var(--tooltip-bg, #1e293b)',
                borderColor: 'var(--tooltip-border, #334155)',
                color: 'var(--tooltip-color, #e2e8f0)',
              }}
            />
            <Legend wrapperStyle={{ fontSize: '11px' }} />
            <Area
              type="monotone"
              dataKey="Upload"
              stroke="#3b82f6"
              fill="#3b82f620"
              strokeWidth={1.5}
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="Download"
              stroke="#8b5cf6"
              fill="#8b5cf620"
              strokeWidth={1.5}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ─── App Traffic (NetFlow) ────────────────────────────────────────────────────

const APP_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
  '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#a855f7',
];

function AppTrafficCard({ mac }: { mac: string }) {
  const [range, setRange] = useState<'2h' | '24h' | '7d'>('24h');

  const { data, isLoading } = useQuery({
    queryKey: ['client-app-traffic', mac, range],
    queryFn: () => trafficApi.client(mac, range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const series = data?.series ?? [];
  const apps = data?.apps ?? [];

  // NetFlow data only exists for clients on networks with export enabled. Latch
  // on the first non-empty result so the card stays mounted once it has shown
  // data — otherwise switching to a range with no traffic (e.g. an idle client
  // over the last 2h) would unmount the whole card, range buttons and all.
  // Setting state during render (guarded) is React's recommended way to derive
  // sticky state without an effect.
  const [hadData, setHadData] = useState(false);
  if (!hadData && (series.length > 0 || apps.length > 0)) setHadData(true);
  if (!isLoading && series.length === 0 && apps.length === 0 && !hadData) return null;

  const ranges = [
    { value: '2h', label: '2h' },
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
  ] as const;

  const chartData = series.map(p => ({
    time: p.time,
    Upload: p.upload,
    Download: p.download,
    label: format(parseISO(p.time), range === '7d' ? 'MMM d HH:mm' : 'HH:mm'),
  }));

  const totalAppBytes = apps.reduce((s, a) => s + a.bytes, 0);

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-white flex items-center gap-2">
          <Activity className="w-4 h-4 text-gray-400" />
          App Traffic
          <span className="text-xs font-normal text-gray-400 dark:text-slate-500">(NetFlow)</span>
        </h2>
        <div className="flex gap-1">
          {ranges.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={clsx(
                'px-2 py-1 text-xs rounded font-medium transition-colors',
                range === r.value
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-48 bg-gray-100 dark:bg-slate-700/40 rounded animate-pulse" />
      ) : chartData.length === 0 && apps.length === 0 ? (
        <div className="h-48 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-slate-500 text-xs bg-gray-50 dark:bg-slate-800/50 rounded">
          <Activity className="w-6 h-6 opacity-30" />
          No traffic data yet for this range
        </div>
      ) : (
        <>
          {chartData.length > 0 && (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-20" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'currentColor' }}
                  className="text-gray-400 dark:text-slate-500"
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={(v) => formatBytes(v)}
                  tick={{ fontSize: 10, fill: 'currentColor' }}
                  className="text-gray-400 dark:text-slate-500"
                  width={60}
                />
                <Tooltip
                  formatter={(value: number) => [formatBytes(value), '']}
                  contentStyle={{
                    fontSize: '11px',
                    backgroundColor: 'var(--tooltip-bg, #1e293b)',
                    borderColor: 'var(--tooltip-border, #334155)',
                    color: 'var(--tooltip-color, #e2e8f0)',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Area type="monotone" dataKey="Download" stroke="#3b82f6" fill="#3b82f620" strokeWidth={1.5} dot={false} />
                <Area type="monotone" dataKey="Upload" stroke="#8b5cf6" fill="#8b5cf620" strokeWidth={1.5} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}

          {apps.length > 0 && (
            <div className="space-y-1.5">
              {apps.slice(0, 8).map((a, i) => (
                <div key={a.app} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: APP_COLORS[i % APP_COLORS.length] }} />
                  <span className="text-gray-700 dark:text-slate-300 flex-1 truncate">{a.app}</span>
                  <span className="text-gray-400 dark:text-slate-500">
                    {totalAppBytes > 0 ? `${((a.bytes / totalAppBytes) * 100).toFixed(1)}%` : ''}
                  </span>
                  <span className="font-medium text-gray-900 dark:text-white w-16 text-right">{formatBytes(a.bytes)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Signal Strength Graph ────────────────────────────────────────────────────

function qualityColor(dbm: number): string {
  if (dbm >= -55) return '#22c55e';  // green-500
  if (dbm >= -65) return '#84cc16';  // lime-500
  if (dbm >= -75) return '#eab308';  // yellow-500
  return '#ef4444';                  // red-500
}

function SignalCard({ mac }: { mac: string }) {
  const [range, setRange] = useState<'2h' | '24h' | '7d'>('24h');

  const { data: raw = [], isLoading } = useQuery({
    queryKey: ['client-signal', mac, range],
    queryFn: () => clientsApi.getSignal(mac, range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const ranges = [
    { value: '2h', label: '2h' },
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
  ] as const;

  // Bars must grow upward from 0, but dBm values are all negative.
  // Offset each value so 0 = worst possible signal (-100 dBm), higher = stronger.
  // Y-axis tickFormatter converts back to real dBm for display.
  const BASELINE = -100;
  const chartData = raw.map((p: SignalPoint) => ({
    ...p,
    label: format(parseISO(p.time), range === '7d' ? 'MMM d HH:mm' : 'HH:mm'),
    bar_value: p.signal_strength - BASELINE,   // always positive
  }));

  // Reference line Y values are also offset
  const refExcellent = -55 - BASELINE; // 45
  const refGood      = -65 - BASELINE; // 35
  const refFair      = -75 - BASELINE; // 25

  // Domain: 0 to just above the highest reading
  const values = chartData.map(p => p.bar_value);
  const yDomainMax = values.length ? Math.min(BASELINE * -1, Math.max(...values) + 3) : 80;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-white flex items-center gap-2">
          <Activity className="w-4 h-4 text-gray-400" />
          Signal Strength
        </h2>
        <div className="flex gap-1">
          {ranges.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={clsx(
                'px-2 py-1 text-xs rounded font-medium transition-colors',
                range === r.value
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-48 bg-gray-100 dark:bg-slate-700/40 rounded animate-pulse" />
      ) : chartData.length === 0 ? (
        <div className="h-48 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-slate-500 text-xs bg-gray-50 dark:bg-slate-800/50 rounded">
          <Activity className="w-6 h-6 opacity-30" />
          No signal data yet for this range
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="opacity-20" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: 'currentColor' }}
                className="text-gray-400 dark:text-slate-500"
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, yDomainMax]}
                tickFormatter={(v) => `${v + BASELINE}`}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                className="text-gray-400 dark:text-slate-500"
                width={46}
                unit=" dBm"
              />
              <Tooltip
                formatter={(_v: number, _n: string, props: { payload?: { signal_strength: number } }) =>
                  [`${props.payload?.signal_strength ?? ''} dBm`, 'Signal']
                }
                contentStyle={{
                  fontSize: '11px',
                  backgroundColor: 'var(--tooltip-bg, #1e293b)',
                  borderColor: 'var(--tooltip-border, #334155)',
                  color: 'var(--tooltip-color, #e2e8f0)',
                }}
              />
              {/* Quality threshold reference lines (offset to bar scale) */}
              <ReferenceLine y={refExcellent} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.6}
                label={{ value: 'Excellent', position: 'insideTopRight', fontSize: 9, fill: '#22c55e' }} />
              <ReferenceLine y={refGood} stroke="#84cc16" strokeDasharray="3 3" strokeOpacity={0.6}
                label={{ value: 'Good', position: 'insideTopRight', fontSize: 9, fill: '#84cc16' }} />
              <ReferenceLine y={refFair} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.6}
                label={{ value: 'Fair', position: 'insideTopRight', fontSize: 9, fill: '#eab308' }} />
              <Bar dataKey="bar_value" name="Signal" radius={[2, 2, 0, 0]}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={qualityColor(entry.signal_strength)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 text-[10px] text-gray-500 dark:text-slate-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500 inline-block" />≥ −55 dBm Excellent</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-lime-500 inline-block" />≥ −65 Good</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-yellow-500 inline-block" />≥ −75 Fair</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />Poor</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ClientDetailPage() {
  const { mac } = useParams<{ mac: string }>();
  const navigate = useNavigate();
  const canWrite = useCanWrite();

  const { data: client, isLoading, isError } = useQuery({
    queryKey: ['client-detail', mac],
    queryFn: () => clientsApi.get(mac!).then(r => r.data),
    enabled: !!mac,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        Loading client…
      </div>
    );
  }

  if (isError || !client) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
        <AlertCircle className="w-8 h-8" />
        <p>Client not found.</p>
        <button onClick={() => navigate(-1)} className="btn-secondary text-sm">Go back</button>
      </div>
    );
  }

  const displayName = client.custom_name || client.hostname || client.mac_address;

  return (
    <div className="space-y-4">
      {/* Breadcrumb / back */}
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-slate-200 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <span>/</span>
        <Link to="/clients" className="hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
          Clients
        </Link>
        <span>/</span>
        <span className="text-gray-700 dark:text-slate-200 font-medium truncate">{displayName}</span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className={clsx(
          'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
          client.active
            ? 'bg-green-100 dark:bg-green-900/30'
            : 'bg-gray-100 dark:bg-slate-700'
        )}>
          {client.client_type === 'wireless'
            ? <Wifi className={clsx('w-5 h-5', client.active ? 'text-green-600 dark:text-green-400' : 'text-gray-400')} />
            : <Network className={clsx('w-5 h-5', client.active ? 'text-green-600 dark:text-green-400' : 'text-gray-400')} />
          }
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{displayName}</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 font-mono">{client.mac_address}</p>
        </div>
        <span className={clsx(
          'ml-auto px-2.5 py-1 rounded-full text-xs font-semibold',
          client.active
            ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
            : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
        )}>
          {client.active ? 'Online' : 'Offline'}
        </span>
      </div>

      {/* Connectivity timeline */}
      <ConnectivityTimeline mac={mac!} />

      {/* Connection diagram */}
      <ConnectionDiagram client={client} />

      {/* Details on left; Traffic + Signal stacked on right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <ClientDetailsCard client={client} canWrite={canWrite} />
        <div className="space-y-4">
          <AppTrafficCard mac={client.mac_address} />
          {client.client_type === 'wireless' && (
            <>
              <TrafficCard mac={mac!} />
              <SignalCard mac={mac!} />
              <RoamingTimeline mac={client.mac_address} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
