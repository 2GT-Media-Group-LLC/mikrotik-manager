import ConfigHealthCard from './ConfigHealthCard';
import { useState } from 'react';
import SshKeyCard from './SshKeyCard';
import IpAddressesCard from './IpAddressesCard';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, CheckCircle, AlertCircle, Server, ShieldCheck } from 'lucide-react';
import { devicesApi, certificatesApi } from '../../services/api';
import type { Device } from '../../types';
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

      <IpAddressesCard deviceId={deviceId} deviceName={device.name} />

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

    </div>
  );
}
