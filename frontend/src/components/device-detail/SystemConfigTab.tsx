import ConfigHealthCard from './ConfigHealthCard';
import { useState } from 'react';
import ReviewChangesButton from '../common/ReviewChangesButton';
import SshKeyCard from './SshKeyCard';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Plus, Trash2, CheckCircle, AlertCircle, Server,
  ShieldCheck, Pencil, Check, X,
} from 'lucide-react';
import { devicesApi, certificatesApi } from '../../services/api';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';
import type { Device, IpAddress, Interface } from '../../types';
import clsx from 'clsx';
import { changedFields } from '../../utils/formDiff';
import { useCanWrite } from '../../hooks/useCanWrite';
import CertificateList from '../CertificateList';
import ListInput from '../common/ListInput';
import { splitList } from '../../utils/ipPrefix';
import { isValidIPv4, isValidIPv6 } from '../../utils/deviceAddress';

interface Props {
  deviceId: number;
  device: Device;
}

export default function SystemConfigTab({ deviceId, device }: Props) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  // ─── System config (identity, NTP, DNS) ──────────────────────────────────
  const { data: sysConfig, isLoading: sysLoading } = useQuery({
    queryKey: ['system-config', deviceId],
    queryFn: () => devicesApi.getSystemConfig(deviceId).then((r) => r.data),
  });

  // ─── Clock ────────────────────────────────────────────────────────────────
  const { data: clockData, isLoading: clockLoading } = useQuery({
    queryKey: ['device-clock', deviceId],
    queryFn: () => devicesApi.getClock(deviceId).then((r) => r.data),
  });

  // ─── Combined edit state ──────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [sysForm, setSysForm] = useState({
    identity: '',
    ntp_enabled: true,
    ntp_primary: '',
    ntp_secondary: '',
    dns_servers: '',
    dns_allow_remote: false,
  });
  const [clockForm, setClockForm] = useState({ date: '', time: '', timezone: '' });
  // What the forms held when editing started, so a save sends only changes.
  const [loadedSys, setLoadedSys] = useState(sysForm);
  const [loadedClock, setLoadedClock] = useState(clockForm);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    if (!sysConfig) return;
    const sys = {
      identity: sysConfig.identity,
      ntp_enabled: sysConfig.ntp.enabled !== 'no' && sysConfig.ntp.enabled !== 'false',
      ntp_primary: sysConfig.ntp['primary-ntp'] || '',
      ntp_secondary: sysConfig.ntp['secondary-ntp'] || '',
      dns_servers: sysConfig.dns['servers'] || '',
      dns_allow_remote: sysConfig.dns['allow-remote-requests'] === 'yes',
    };
    const clock = {
      date: clockData?.date || '',
      time: clockData?.time || '',
      timezone: clockData?.timezone || '',
    };
    setSysForm(sys); setLoadedSys(sys);
    setClockForm(clock); setLoadedClock(clock);
    setSaveError('');
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      // Only what changed. Sending the whole form re-sent the clock as it was
      // when editing started (rewinding the device) and rewrote NTP and DNS
      // on every save, even one that only renamed the device.
      const sysChanges = changedFields(loadedSys, sysForm);
      const clockChanges = changedFields(loadedClock, clockForm);
      if (Object.keys(sysChanges).length) await devicesApi.updateSystemConfig(deviceId, sysChanges);
      if (Object.keys(clockChanges).length) await devicesApi.setClock(deviceId, clockChanges);
      queryClient.invalidateQueries({ queryKey: ['system-config', deviceId] });
      queryClient.invalidateQueries({ queryKey: ['device-clock', deviceId] });
      queryClient.invalidateQueries({ queryKey: ['device', deviceId] });
      setEditing(false);
      setSaveSuccess('System configuration updated');
      setTimeout(() => setSaveSuccess(''), 3000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // ─── IP Addresses ────────────────────────────────────────────────────────
  const { data: ipAddresses = [], isLoading: ipLoading, refetch: refetchIp } = useQuery({
    queryKey: ['ip-addresses', deviceId],
    queryFn: () => devicesApi.getIpAddresses(deviceId).then((r) => r.data as IpAddress[]),
  });

  const { data: interfaces = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data as Interface[]),
  });

  const [newIp, setNewIp] = useState({ address: '', interface: '' });
  const [ipError, setIpError] = useState('');
  // Predicted lockout (409 + verdict) plus the retry that confirms it.
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);

  const addIpRequest = (confirm: boolean) =>
    devicesApi.addIpAddress(deviceId, confirm ? { ...newIp, confirm_lockout: true } : newIp);
  const addIpMutation = useMutation({
    mutationFn: addIpRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ip-addresses', deviceId] });
      setNewIp({ address: '', interface: '' });
      setIpError('');
      setLockout(null);
    },
    onError: (err: unknown) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => addIpMutation.mutate(true) }); return; }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setIpError(msg || 'Failed to add IP address');
    },
  });

  const removeIpMutation = useMutation({
    mutationFn: ({ id, confirm = false }: { id: string; confirm?: boolean }) =>
      devicesApi.removeIpAddress(deviceId, id, confirm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ip-addresses', deviceId] });
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => removeIpMutation.mutate({ id: vars.id, confirm: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setIpError(msg || 'Failed to remove IP address');
    },
  });

  // Editing an address in place (#285). Only changed fields are sent, so a
  // comment edit can't also rewrite the address.
  const [editingIp, setEditingIp] = useState<{ id: string; orig: IpAddress; address: string; interface: string; comment: string; enabled: boolean } | null>(null);
  const ipEdits = (e: NonNullable<typeof editingIp>) => {
    const d: { address?: string; interface?: string; comment?: string; disabled?: boolean } = {};
    if (e.address.trim() !== e.orig.address) d.address = e.address.trim();
    if (e.interface !== e.orig.interface) d.interface = e.interface;
    if (e.comment !== (e.orig.comment ?? '')) d.comment = e.comment;
    if (e.enabled !== (e.orig.disabled !== 'true')) d.disabled = !e.enabled;
    return d;
  };
  const updateIpMutation = useMutation({
    mutationFn: ({ e, confirm = false }: { e: NonNullable<typeof editingIp>; confirm?: boolean }) =>
      devicesApi.updateIpAddress(deviceId, e.id, ipEdits(e), confirm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ip-addresses', deviceId] });
      setEditingIp(null);
      setIpError('');
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => updateIpMutation.mutate({ e: vars.e, confirm: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setIpError(msg || 'Failed to update IP address');
    },
  });

  const { data: certData, isLoading: certLoading } = useQuery({
    queryKey: ['device-certificates', deviceId],
    queryFn: () => certificatesApi.list(deviceId).then((r) => r.data),
    staleTime: 60_000,
  });

  const isLoading = sysLoading || clockLoading;

  return (
    <div className="space-y-6">
      {/* Config Health first (#239): what the configuration gets wrong, with
          one-click fixes where there's one right answer. */}
      <div className="card p-5">
        <ConfigHealthCard deviceId={deviceId} deviceName={device.name} />
      </div>

      {/* ── System Settings (identity, NTP, DNS, clock) ── */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Server className="w-4 h-4 text-blue-500" />
            System Settings
          </h3>
          {canWrite && !editing && (
            <button
              onClick={startEdit}
              disabled={isLoading || !sysConfig}
              className="btn-secondary text-xs py-1.5"
            >
              Edit
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : !sysConfig ? (
          <div className="text-sm text-gray-400">Could not load system configuration</div>
        ) : editing ? (
          <div className="space-y-5">
            {/* Identity */}
            <div>
              <label className="label">Device Identity (Hostname)</label>
              <input
                className="input"
                value={sysForm.identity}
                onChange={(e) => setSysForm((f) => ({ ...f, identity: e.target.value }))}
                placeholder="router"
              />
            </div>

            {/* Date / Time / Timezone */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                Date &amp; Time
              </h4>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Date</label>
                  <input
                    type="date"
                    className="input"
                    value={clockForm.date}
                    onChange={(e) => setClockForm((f) => ({ ...f, date: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">Time</label>
                  <input
                    type="time"
                    className="input"
                    value={clockForm.time}
                    onChange={(e) => setClockForm((f) => ({ ...f, time: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">Timezone</label>
                  <input
                    className="input"
                    value={clockForm.timezone}
                    onChange={(e) => setClockForm((f) => ({ ...f, timezone: e.target.value }))}
                    placeholder="America/New_York"
                  />
                  <p className="text-xs text-gray-400 mt-1">IANA name (e.g. UTC, Europe/London)</p>
                </div>
              </div>
            </div>

            {/* NTP */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                NTP Client
              </h4>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="ntp_enabled"
                    checked={sysForm.ntp_enabled}
                    onChange={(e) => setSysForm((f) => ({ ...f, ntp_enabled: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <label htmlFor="ntp_enabled" className="text-sm text-gray-700 dark:text-slate-300">
                    NTP enabled
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Primary NTP server</label>
                    <input
                      className="input"
                      value={sysForm.ntp_primary}
                      onChange={(e) => setSysForm((f) => ({ ...f, ntp_primary: e.target.value }))}
                      placeholder="0.pool.ntp.org"
                    />
                  </div>
                  <div>
                    <label className="label">Secondary NTP server</label>
                    <input
                      className="input"
                      value={sysForm.ntp_secondary}
                      onChange={(e) => setSysForm((f) => ({ ...f, ntp_secondary: e.target.value }))}
                      placeholder="1.pool.ntp.org"
                    />
                  </div>
                </div>
                {Number(sysConfig?.ntp['extra-servers'] || 0) > 0 && (
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                    This device has {sysConfig?.ntp['extra-servers']} more NTP server{sysConfig?.ntp['extra-servers'] === '1' ? '' : 's'} after
                    these two; they&apos;re kept as they are.
                  </p>
                )}
              </div>
            </div>

            {/* DNS */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                DNS
              </h4>
              <div className="space-y-2">
                <div>
                  <label className="label">DNS Servers</label>
                  <ListInput value={splitList(sysForm.dns_servers)} ariaLabel="DNS servers" placeholder="8.8.8.8"
                    onChange={(v) => setSysForm((f) => ({ ...f, dns_servers: v.join(',') }))}
                    validate={(e) => (isValidIPv4(e) || isValidIPv6(e) ? null : `${e} isn\u2019t an IP address`)} />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="dns_remote"
                    checked={sysForm.dns_allow_remote}
                    onChange={(e) => setSysForm((f) => ({ ...f, dns_allow_remote: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <label htmlFor="dns_remote" className="text-sm text-gray-700 dark:text-slate-300">
                    Allow remote DNS requests (act as DNS server)
                  </label>
                </div>
              </div>
            </div>

            {saveError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary flex items-center gap-2"
              >
                {saving && <RefreshCw className="w-4 h-4 animate-spin" />}
                Save Changes
              </button>
              <button onClick={() => setEditing(false)} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-y-3 gap-x-8 text-sm">
            {[
              ['Identity', sysConfig.identity || '—'],
              ['Date', clockData?.date || '—'],
              ['Time', clockData?.time || '—'],
              ['Timezone', clockData?.timezone || '—'],
              ['NTP Enabled', sysConfig.ntp.enabled !== 'no' ? 'Yes' : 'No'],
              ['Primary NTP', sysConfig.ntp['primary-ntp'] || '—'],
              ['Secondary NTP', sysConfig.ntp['secondary-ntp'] || '—'],
              ['DNS Servers', sysConfig.dns.servers || '—'],
              ['Allow Remote DNS', sysConfig.dns['allow-remote-requests'] === 'yes' ? 'Yes' : 'No'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-gray-100 dark:border-slate-700 pb-2">
                <span className="text-gray-500 dark:text-slate-400">{k}</span>
                <span className="font-medium text-gray-900 dark:text-white text-right">{v}</span>
              </div>
            ))}
          </div>
        )}

        {saveSuccess && (
          <div className="flex items-center gap-2 mt-3 text-sm text-green-600">
            <CheckCircle className="w-4 h-4" /> {saveSuccess}
          </div>
        )}
      </div>

      {/* ── IP Addresses ── */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">IP Addresses</h3>
          <button
            onClick={() => refetchIp()}
            className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', ipLoading && 'animate-spin')} />
          </button>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-slate-700">
              <th className="table-header px-4 py-2 text-left">Address / Prefix</th>
              <th className="table-header px-4 py-2 text-left">Network</th>
              <th className="table-header px-4 py-2 text-left">Interface</th>
              <th className="table-header px-4 py-2 text-left">Comment</th>
              <th className="table-header px-4 py-2 text-left">Status</th>
              <th className="table-header px-4 py-2 w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
            {ipLoading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Loading...</td></tr>
            ) : (ipAddresses as IpAddress[]).length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No IP addresses</td></tr>
            ) : (
              (ipAddresses as IpAddress[]).map((ip) => editingIp?.id === ip['.id'] ? (
                <tr key={ip['.id']} className="bg-blue-50/50 dark:bg-slate-700/40">
                  <td className="px-4 py-2" colSpan={2}>
                    <input className="input font-mono py-1 text-sm" value={editingIp.address} aria-label="Address / prefix"
                      onChange={(e) => setEditingIp((x) => x && { ...x, address: e.target.value })} />
                  </td>
                  <td className="px-4 py-2">
                    <select className="input py-1 text-sm" value={editingIp.interface} aria-label="Interface"
                      onChange={(e) => setEditingIp((x) => x && { ...x, interface: e.target.value })}>
                      {!(interfaces as Interface[]).some((i) => i.name === editingIp.interface) && <option value={editingIp.interface}>{editingIp.interface}</option>}
                      {(interfaces as Interface[]).map((i) => <option key={i.name} value={i.name}>{i.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input className="input py-1 text-sm" value={editingIp.comment} placeholder="Comment" aria-label="Comment"
                      onChange={(e) => setEditingIp((x) => x && { ...x, comment: e.target.value })} />
                  </td>
                  <td className="px-4 py-2">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300">
                      <input type="checkbox" checked={editingIp.enabled}
                        onChange={(e) => setEditingIp((x) => x && { ...x, enabled: e.target.checked })} /> enabled
                    </label>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => updateIpMutation.mutate({ e: editingIp })}
                        disabled={updateIpMutation.isPending || Object.keys(ipEdits(editingIp)).length === 0}
                        className="p-1 rounded text-green-600 hover:text-green-700 disabled:opacity-40" title="Save">
                        {updateIpMutation.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={() => { setEditingIp(null); setIpError(''); }} className="p-1 rounded text-gray-400 hover:text-gray-600" title="Cancel">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={ip['.id']} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2 font-mono text-gray-900 dark:text-white">{ip.address}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">{ip.network || '—'}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-slate-300">{ip.interface}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-slate-400">{ip.comment || ''}</td>
                  <td className="px-4 py-2">
                    <span className={clsx(
                      'text-xs font-medium',
                      ip.disabled === 'true' ? 'text-gray-400' : 'text-green-600 dark:text-green-400'
                    )}>
                      {ip.dynamic === 'true' ? 'dynamic' : ip.disabled === 'true' ? 'disabled' : 'active'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {canWrite && ip.dynamic !== 'true' && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            setIpError('');
                            setEditingIp({ id: ip['.id'], orig: ip, address: ip.address, interface: ip.interface, comment: ip.comment ?? '', enabled: ip.disabled !== 'true' });
                          }}
                          className="p-1 rounded text-gray-400 hover:text-blue-500 transition-colors"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Remove ${ip.address} from ${ip.interface}?`)) {
                              removeIpMutation.mutate({ id: ip['.id'] });
                            }
                          }}
                          className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                          title="Remove"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {canWrite && <div className="p-4 border-t border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="label">Address / Prefix (e.g. 192.168.1.1/24)</label>
              <input
                className="input font-mono"
                value={newIp.address}
                onChange={(e) => setNewIp((f) => ({ ...f, address: e.target.value }))}
                placeholder="192.168.1.1/24"
              />
            </div>
            <div className="w-44">
              <label className="label">Interface</label>
              <select
                className="input"
                value={newIp.interface}
                onChange={(e) => setNewIp((f) => ({ ...f, interface: e.target.value }))}
              >
                <option value="">Select...</option>
                {(interfaces as Interface[]).map((i) => (
                  <option key={i.name} value={i.name}>{i.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => addIpMutation.mutate(false)}
              disabled={!newIp.address || !newIp.interface || addIpMutation.isPending}
              className="btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
            <ReviewChangesButton request={() => addIpRequest(false)} onApply={() => addIpMutation.mutate(false)} applyLabel="Add"
              deviceName={device.name} disabled={!newIp.address || !newIp.interface || addIpMutation.isPending} />
          </div>
          {ipError && (
            <div className="flex items-center gap-2 mt-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" /> {ipError}
            </div>
          )}
        </div>}
      </div>

      {/* ── Certificates ── */}
      <div className="card p-5">
        <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-1">
          <ShieldCheck className="w-4 h-4 text-blue-500" />
          Certificates
        </h3>
        <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
          Collected on each slow poll.{' '}
          {certData && (certData.alertingEnabled
            ? `Alerting ${certData.warnDays} days before expiry.`
            : 'Expiry alerting is off — enable "Certificate expiring soon" in Settings → Alerts.')}
        </p>
        {certLoading
          ? <p className="text-sm text-gray-400">Loading…</p>
          : <CertificateList certificates={certData?.certificates ?? []} storageKey="device" />}
      </div>


      <div className="card p-5">
        {/* No SSH login stored means the key is installed for the API user (see resolveKeyCredentials). */}
        <SshKeyCard deviceId={deviceId} sshUsername={device.ssh_username || device.api_username} />
      </div>

      {lockout && (
        <LockoutVerdictDialog
          deviceId={deviceId}
          verdict={lockout.verdict}
          confirmPhrase={device.name}
          pending={addIpMutation.isPending || removeIpMutation.isPending}
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}
    </div>
  );
}
