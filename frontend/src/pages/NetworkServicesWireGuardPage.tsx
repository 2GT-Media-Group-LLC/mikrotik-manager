import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Shield, RefreshCw, AlertTriangle, Power, Plus, Pencil, Trash2,
  ChevronDown, ChevronRight, Key, Copy, Check, X, Lock,
} from 'lucide-react';
import clsx from 'clsx';
import { networkServicesApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import { useGuardedWrite, GuardedWriteUi } from '../components/ChangeGuardDialog';
import { apiErrorMessage } from '../utils/apiError';
import { rosDurationSeconds } from '../utils/rosDuration';
import ListInput from '../components/common/ListInput';
import { isIpOrPrefix, splitList } from '../utils/ipPrefix';
import { Link } from 'react-router-dom';
import DeviceTypePill from '../components/devices/DeviceTypePill';
import TagChips, { type TagLike } from '../components/devices/TagChips';

type NS = Record<string, string>;

// ─── helpers ─────────────────────────────────────────────────────────────────

function truncateKey(key: string): string {
  if (!key || key.length <= 16) return key;
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}

function formatBytes(bytes: string): string {
  const n = parseInt(bytes);
  if (!n || isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      className="p-1 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ─── Interface form modal ─────────────────────────────────────────────────────

interface IfaceFormProps {
  deviceId: number;
  existing?: NS;
  onClose: () => void;
}

function IfaceForm({ deviceId, existing, onClose }: IfaceFormProps) {
  const qc = useQueryClient();
  const [name, setName]             = useState(existing?.['name'] || '');
  const [listenPort, setListenPort] = useState(existing?.['listen-port'] || '13231');
  const [mtu, setMtu]               = useState(existing?.['mtu'] || '1420');
  const [disabled, setDisabled]     = useState(existing?.['disabled'] === 'true');

  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => {
      const body: NS = { name, 'listen-port': listenPort, mtu, disabled: disabled ? 'yes' : 'no' };
      return existing?.['.id']
        ? networkServicesApi.updateWireGuardInterface(deviceId, existing['.id'], body)
        : networkServicesApi.addWireGuardInterface(deviceId, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ns-wireguard', deviceId] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {existing ? 'Edit' : 'Add'} WireGuard Interface
          </h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Name *</label>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="wireguard1" disabled={!!existing} />
            {!existing && <p className="mt-0.5 text-xs text-gray-400">RouterOS will auto-generate a key pair.</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Listen Port</label>
              <input className="input w-full" type="number" value={listenPort} onChange={e => setListenPort(e.target.value)} placeholder="13231" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">MTU</label>
              <input className="input w-full" type="number" value={mtu} onChange={e => setMtu(e.target.value)} placeholder="1420" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button role="switch" aria-checked={!disabled} onClick={() => setDisabled(v => !v)}
              className={clsx('relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors', !disabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600')}>
              <span className={clsx('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform', !disabled ? 'translate-x-4' : 'translate-x-0')} />
            </button>
            <span className="text-sm text-gray-700 dark:text-slate-200">Enabled</span>
          </div>
        </div>
        <div className="px-5 pb-4 flex items-center gap-3">
          <button onClick={() => save.mutate()} disabled={!name || save.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
            <Check className="w-3.5 h-3.5" />{save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          {save.isError && <span className="text-xs text-red-500">{apiErrorMessage(save.error)}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Peer form modal ──────────────────────────────────────────────────────────

interface PeerFormProps {
  deviceId: number;
  ifaceName: string;
  existing?: NS;
  onClose: () => void;
}

function PeerForm({ deviceId, ifaceName, existing, onClose }: PeerFormProps) {
  const qc = useQueryClient();
  const [pubKey, setPubKey]         = useState(existing?.['public-key'] || '');
  const [allowedAddr, setAllowedAddr] = useState<string[]>(splitList(existing?.['allowed-address'] || ''));
  const [endpointAddr, setEndpointAddr] = useState(existing?.['endpoint-address'] || '');
  const [endpointPort, setEndpointPort] = useState(existing?.['endpoint-port'] && existing['endpoint-port'] !== '0' ? existing['endpoint-port'] : '');
  // RouterOS reports a duration ("25s"), which a number box can't show, so the
  // field looked empty and saving it cleared the setting (#206).
  const [keepalive, setKeepalive]   = useState(String(rosDurationSeconds(existing?.['persistent-keepalive']) ?? ''));
  const [presharedKey, setPresharedKey] = useState('');

  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => {
      const body: NS = {
        interface: ifaceName,
        'public-key': pubKey,
        'allowed-address': allowedAddr.join(','),
      };
      // When editing, an emptied field is sent as '' so it is cleared on the
      // device; it used to be left out and the old value stayed (P2-10). The
      // preshared key is the exception: its box is always blank, meaning keep.
      const opt = (key: string, value: string) => {
        if (value) Object.assign(body, { [key]: value });
        else if (existing) Object.assign(body, { [key]: '' });
      };
      opt('endpoint-address', endpointAddr);
      // RouterOS wants a number here and uses 0 for "no endpoint"; an empty
      // value made every edit of a peer without one fail.
      if (endpointPort && endpointPort !== '0') body['endpoint-port'] = endpointPort;
      else if (existing) body['endpoint-port'] = '0';
      // RouterOS rejects an empty keepalive; 0 is how it's turned off.
      if (keepalive) body['persistent-keepalive'] = `${keepalive}s`;
      else if (existing) body['persistent-keepalive'] = '0';
      if (presharedKey) body['preshared-key'] = presharedKey;

      return existing?.['.id']
        ? networkServicesApi.updateWireGuardPeer(deviceId, existing['.id'], body)
        : networkServicesApi.addWireGuardPeer(deviceId, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ns-wireguard', deviceId] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {existing ? 'Edit' : 'Add'} Peer — {ifaceName}
          </h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Peer Public Key *</label>
            <input className="input w-full font-mono text-xs" value={pubKey} onChange={e => setPubKey(e.target.value)} placeholder="base64-encoded WireGuard public key" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Allowed Addresses *</label>
            <ListInput value={allowedAddr} onChange={setAllowedAddr} ariaLabel="Allowed addresses"
              validate={(e) => (isIpOrPrefix(e) ? null : `${e} isn't an IP address or prefix`)}
              placeholder="10.0.0.2/32 or 0.0.0.0/0" />
            <p className="mt-0.5 text-xs text-gray-400">Addresses or prefixes this peer may use. Press Enter after each.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Endpoint Address</label>
              <input className="input w-full" value={endpointAddr} onChange={e => setEndpointAddr(e.target.value)} placeholder="peer.example.com or IP" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Endpoint Port</label>
              <input className="input w-full" type="number" value={endpointPort} onChange={e => setEndpointPort(e.target.value)} placeholder="51820" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Persistent Keepalive (s)</label>
              <input className="input w-full" type="number" value={keepalive} onChange={e => setKeepalive(e.target.value)} placeholder="25" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Preshared Key</label>
              <input className="input w-full font-mono text-xs" value={presharedKey} onChange={e => setPresharedKey(e.target.value)} placeholder="Optional" type="password" />
            </div>
          </div>
        </div>
        <div className="px-5 pb-4 flex items-center gap-3">
          <button onClick={() => save.mutate()} disabled={!pubKey || allowedAddr.length === 0 || save.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
            <Check className="w-3.5 h-3.5" />{save.isPending ? 'Saving…' : 'Save Peer'}
          </button>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          {save.isError && <span className="text-xs text-red-500">{apiErrorMessage(save.error)}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/** One device's WireGuard interfaces and peers, as a card (#209). */
function DeviceWireGuardCard({ device }: { device: { id: number; name: string; device_type?: string; status?: string; tags?: TagLike[] } }) {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const deviceId = device.id;
  const [expandedIface, setExpandedIface] = useState<string | null>(null);
  const [ifaceForm, setIfaceForm] = useState<NS | 'new' | null>(null);
  const [peerForm, setPeerForm] = useState<{ ifaceName: string; existing?: NS } | null>(null);

  const { data: wg, isLoading, refetch, isFetching, error } = useQuery({
    queryKey: ['ns-wireguard', deviceId],
    queryFn: () => networkServicesApi.getWireGuard(deviceId).then(r => r.data),
  });

  // Turning off or deleting the tunnel the manager arrives through is predicted
  // as a lockout; confirming re-sends the change (outside review P2-8).
  const guard = useGuardedWrite();
  const [writeError, setWriteError] = useState('');
  const failed = (e: unknown) => setWriteError(apiErrorMessage(e, 'Operation failed'));
  const done = (res: unknown) => { qc.invalidateQueries({ queryKey: ['ns-wireguard', deviceId] }); setWriteError(''); guard.onSuccess(res); };

  const toggleIface = useMutation({
    mutationFn: ({ interfaceId, disabled, confirm }: { interfaceId: string; disabled: boolean; confirm?: boolean }) =>
      networkServicesApi.toggleWireGuard(deviceId, interfaceId, disabled, confirm),
    onSuccess: done,
  });

  const deleteIface = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) => networkServicesApi.deleteWireGuardInterface(deviceId, id, confirm),
    onSuccess: done,
  });
  const toggle = (interfaceId: string, disabled: boolean) => toggleIface.mutate({ interfaceId, disabled }, {
    onError: guard.onError(() => toggleIface.mutate({ interfaceId, disabled, confirm: true }, { onError: failed }), failed),
  });
  const removeIface = (id: string) => deleteIface.mutate({ id }, {
    onError: guard.onError(() => deleteIface.mutate({ id, confirm: true }, { onError: failed }), failed),
  });

  const deletePeer = useMutation({
    mutationFn: (id: string) => networkServicesApi.deleteWireGuardPeer(deviceId, id),
    onSuccess: done,
    // A failure used to vanish without a word.
    onError: failed,
  });

  const peersForIface = (name: string) => (wg?.peers || []).filter(p => p['interface'] === name);
  // The tunnel and peer the manager reaches this device through (#205): marked,
  // and not offered for deletion or switching off.
  const mgmt = wg?.management ?? null;
  const isMgmtIface = (iface: NS) => !!mgmt && (iface['.id'] === mgmt.interface_id || iface['name'] === mgmt.interface);
  const carriesManager = (peer: NS) => !!mgmt && mgmt.peer_ids.includes(peer['.id']);

  return (
    <div className="card overflow-hidden">
      {/* Modals */}
      {ifaceForm && (
        <IfaceForm
          deviceId={deviceId}
          existing={ifaceForm === 'new' ? undefined : ifaceForm as NS}
          onClose={() => setIfaceForm(null)}
        />
      )}
      {peerForm && (
        <PeerForm
          deviceId={deviceId}
          ifaceName={peerForm.ifaceName}
          existing={peerForm.existing}
          onClose={() => setPeerForm(null)}
        />
      )}

      {writeError && <div className="m-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">{writeError}</div>}
      <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={device.name}
        pending={toggleIface.isPending || deleteIface.isPending} />

      {/* Device header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-200 dark:border-slate-700">
        <DeviceTypePill type={device.device_type} />
        <Link to={`/devices/${device.id}`} className="cell-primary hover:underline">{device.name}</Link>
        <TagChips tags={device.tags} />
        {device.status !== 'online' && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><AlertTriangle className="w-3.5 h-3.5" />offline</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canWrite && (
            <button onClick={() => setIfaceForm('new')}
              className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors">
              <Plus className="w-3 h-3" />New Interface
            </button>
          )}
          <button onClick={() => refetch()} disabled={isFetching} title="Refresh" aria-label="Refresh"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-50">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {isLoading && <div className="p-5 text-center text-sm text-gray-400 dark:text-slate-500">Loading…</div>}
      {error && (
        <div className="p-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />Failed: {apiErrorMessage(error)}
        </div>
      )}

      {wg && wg.interfaces.length === 0 && !isLoading && (
        <div className="p-5 text-center text-sm text-gray-400 dark:text-slate-500">No WireGuard interfaces.</div>
      )}

      {wg && wg.interfaces.map(iface => {
        const id = iface['.id'] || '';
        const name = iface['name'] || id;
        const disabled = iface['disabled'] === 'true';
        const running = iface['running'] === 'true';
        const peers = peersForIface(name);
        const isExpanded = expandedIface === name;

        return (
          <div key={id || name} className="border-b last:border-b-0 border-gray-100 dark:border-slate-700/60">
            {/* Interface header */}
            <div className="flex items-center border-b border-gray-200 dark:border-slate-700">
              <button onClick={() => setExpandedIface(isExpanded ? null : name)}
                className="flex items-center gap-2 flex-1 px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-slate-800/40 transition-colors">
                {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                <Shield className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                <span className="text-sm font-semibold text-gray-700 dark:text-slate-200">{name}</span>
                {iface['listen-port'] && <span className="text-xs text-gray-400 dark:text-slate-500">:{iface['listen-port']}</span>}
                {isMgmtIface(iface) && (
                  <span title={mgmt!.reason}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                    <Lock className="w-3 h-3" /> Manager&apos;s tunnel
                  </span>
                )}
              </button>

              <div className="flex items-center gap-2 px-3">
                <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                  running && !disabled ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                  : disabled ? 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
                  : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400')}>
                  <span className={clsx('w-1.5 h-1.5 rounded-full', running && !disabled ? 'bg-green-500' : disabled ? 'bg-gray-400' : 'bg-amber-400')} />
                  {disabled ? 'Disabled' : running ? 'Running' : 'Stopped'}
                </span>
                {canWrite && id && (
                  <>
                    <button onClick={() => toggle(id, !disabled)}
                      disabled={isMgmtIface(iface) && !disabled}
                      title={isMgmtIface(iface) && !disabled ? 'The manager reaches this device through this tunnel, so it can\u2019t be turned off from here' : disabled ? 'Enable' : 'Disable'}
                      className={clsx('p-1.5 rounded-lg transition-colors',
                        disabled ? 'text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20'
                        : 'text-green-600 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20')}>
                      <Power className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setIfaceForm(iface)} title="Edit"
                      className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => { if (confirm(`Delete WireGuard interface "${name}" and all its peers?`)) removeIface(id); }}
                      disabled={isMgmtIface(iface)}
                      title={isMgmtIface(iface) ? 'The manager reaches this device through this tunnel, so it can\u2019t be deleted from here' : 'Delete'}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {isExpanded && (
              <div className="p-5 space-y-5">
                {/* Interface details */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {iface['public-key'] && (
                    <div className="sm:col-span-2">
                      <div className="text-xs text-gray-400 dark:text-slate-500 mb-1 flex items-center gap-1">
                        <Key className="w-3 h-3" /> Public Key
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-mono text-gray-700 dark:text-slate-300 break-all flex-1">{iface['public-key']}</code>
                        <CopyButton text={iface['public-key']} />
                      </div>
                    </div>
                  )}
                  {iface['mtu'] && (
                    <div><div className="text-xs text-gray-400 dark:text-slate-500 mb-0.5">MTU</div><div className="text-sm text-gray-900 dark:text-white">{iface['mtu']}</div></div>
                  )}
                </div>

                {/* Peers */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">
                      Peers ({peers.length})
                    </h3>
                    {canWrite && (
                      <button onClick={() => setPeerForm({ ifaceName: name })}
                        className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors">
                        <Plus className="w-3 h-3" />Add Peer
                      </button>
                    )}
                  </div>

                  {peers.length === 0 ? (
                    <p className="text-sm text-gray-400 dark:text-slate-500">No peers configured.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Public Key</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Allowed Addresses</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Endpoint</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">TX / RX</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Last Handshake</th>
                            {canWrite && <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {peers.map((peer, i) => (
                            <tr key={peer['.id'] || i} className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40', i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1">
                                  <code className="text-xs font-mono text-gray-700 dark:text-slate-300">{truncateKey(peer['public-key'] || '')}</code>
                                  {peer['public-key'] && <CopyButton text={peer['public-key']} />}
                                  {carriesManager(peer) && (
                                    <span title={mgmt!.peer_certain ? 'This peer carries the manager\u2019s connection to the device' : 'The manager\u2019s address couldn\u2019t be seen, so this peer may carry its connection'}
                                      className="ml-1 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                                      <Lock className="w-2.5 h-2.5" /> {mgmt!.peer_certain ? 'Manager' : 'Maybe manager'}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-xs font-mono text-gray-600 dark:text-slate-300">{peer['allowed-address'] || '—'}</td>
                              <td className="px-3 py-2 text-xs text-gray-600 dark:text-slate-300">
                                {peer['endpoint-address'] ? `${peer['endpoint-address']}:${peer['endpoint-port'] || '?'}` : '—'}
                              </td>
                              <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">
                                {(peer['tx'] || peer['rx']) ? `${formatBytes(peer['tx'] || '0')} / ${formatBytes(peer['rx'] || '0')}` : '—'}
                              </td>
                              <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">
                                {peer['last-handshake'] || '—'}
                              </td>
                              {canWrite && (
                                <td className="px-3 py-2">
                                  <div className="flex items-center justify-end gap-1">
                                    <button onClick={() => setPeerForm({ ifaceName: name, existing: peer })}
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button onClick={() => { if (confirm('Delete this peer?')) deletePeer.mutate(peer['.id']); }}
                                      disabled={carriesManager(peer) && mgmt!.peer_certain}
                                      title={carriesManager(peer) && mgmt!.peer_certain ? 'This peer carries the manager\u2019s connection, so it can\u2019t be deleted from here' : 'Delete'}
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Every device in the site at once (#209), the way CAPsMAN controllers show on
 * the Wireless page, instead of picking one device at a time. Devices with
 * WireGuard get a card; the rest are listed underneath with a way to add one.
 */
export default function NetworkServicesWireGuardPage() {
  const canWrite = useCanWrite();
  const [adding, setAdding] = useState<number | null>(null);

  const { data: devices = [], isLoading: devicesLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });
  // How many WireGuard interfaces each device has, from the services overview.
  const { data: overview = [], isLoading: overviewLoading } = useQuery({
    queryKey: ['network-services-overview'],
    queryFn: () => networkServicesApi.overview().then(r => r.data as Record<string, unknown>[]),
    staleTime: 60_000,
  });
  const wgCount = new Map(overview.map((o) => [o.id as number, (o.wireguard as { total?: number } | null)?.total ?? null]));
  const withWg = devices.filter((d) => (wgCount.get(d.id) ?? 0) > 0 || d.id === adding);
  const unread = devices.filter((d) => wgCount.has(d.id) && wgCount.get(d.id) === null && d.id !== adding);
  const without = devices.filter((d) => wgCount.get(d.id) === 0 && d.id !== adding);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">WireGuard</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">WireGuard interfaces and peers on every device in this site</p>
      </div>

      {(devicesLoading || overviewLoading) && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading…</div>}

      {!devicesLoading && !overviewLoading && withWg.length === 0 && (
        <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">No device in this site has a WireGuard interface.</div>
      )}

      {withWg.map((d) => <DeviceWireGuardCard key={d.id} device={d} />)}

      {(without.length > 0 || unread.length > 0) && !overviewLoading && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-200">
            Without WireGuard ({without.length}){unread.length > 0 && <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">{unread.length} couldn&apos;t be read</span>}
          </div>
          <div className="divide-y divide-gray-100 dark:divide-slate-700/60">
            {[...without, ...unread].map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-5 py-2">
                <DeviceTypePill type={d.device_type} />
                <Link to={`/devices/${d.id}`} className="cell-primary hover:underline">{d.name}</Link>
                <TagChips tags={d.tags} />
                {wgCount.get(d.id) === null && <span className="text-xs text-amber-600 dark:text-amber-400">couldn&apos;t read</span>}
                {canWrite && (
                  <button onClick={() => setAdding(d.id)} className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline">
                    Show / add interface
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
