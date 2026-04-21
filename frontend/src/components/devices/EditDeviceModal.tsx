import { useEffect, useMemo, useState, FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, CheckCircle, AlertCircle, Loader2, Network } from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { Device, DeviceType, IpAddress } from '../../types';

interface Props {
  device: Device;
  onClose: () => void;
  onSuccess: () => void;
}

// Strip the CIDR mask from "192.168.88.1/24" → "192.168.88.1" so the value
// matches the format stored in `devices.ip_address`.
function addrWithoutMask(addr: string): string {
  if (!addr) return '';
  const slash = addr.indexOf('/');
  return slash === -1 ? addr : addr.slice(0, slash);
}

// Hide link-local / localhost / invalid rows from the IP picker.
function isSelectableIp(row: IpAddress): boolean {
  const raw = addrWithoutMask(row.address || '');
  if (!raw) return false;
  if (row.disabled === 'true') return false;
  if (row.invalid === 'true') return false;
  if (raw === '127.0.0.1' || raw === '::1') return false;
  if (raw.toLowerCase().startsWith('fe80:')) return false;
  if (raw.startsWith('169.254.')) return false;
  return true;
}

export default function EditDeviceModal({ device, onClose, onSuccess }: Props) {
  const [form, setForm] = useState({
    name: device.name,
    ip_address: device.ip_address,
    api_port: String(device.api_port ?? 8728),
    api_username: device.api_username ?? 'admin',
    api_password: '',
    ssh_port: String(device.ssh_port ?? 22),
    ssh_username: device.ssh_username ?? '',
    ssh_password: '',
    device_type: device.device_type,
    notes: device.notes ?? '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Live IPs from the router itself — useful so you can change the
  // management IP to something the device actually owns instead of guessing.
  const { data: ipRows, isLoading: ipsLoading, error: ipsError } = useQuery({
    queryKey: ['device-ips', device.id],
    queryFn: () => devicesApi.getIpAddresses(device.id).then((r) => r.data),
    enabled: device.status === 'online',
    staleTime: 30_000,
  });

  const candidateIps = useMemo(() => {
    const seen = new Set<string>();
    const out: { address: string; cidr: string; iface: string }[] = [];
    for (const row of (ipRows ?? []) as IpAddress[]) {
      if (!isSelectableIp(row)) continue;
      const bare = addrWithoutMask(row.address);
      if (seen.has(bare)) continue;
      seen.add(bare);
      out.push({ address: bare, cidr: row.address, iface: row.interface });
    }
    // Always include the current IP so it can be reselected
    if (device.ip_address && !seen.has(device.ip_address)) {
      out.unshift({ address: device.ip_address, cidr: device.ip_address, iface: '(current)' });
    }
    return out;
  }, [ipRows, device.ip_address]);

  const ipWasDetected = candidateIps.some((c) => c.address === form.ip_address);

  useEffect(() => { setError(''); }, [form.ip_address, form.api_port, form.api_username, form.api_password]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.ip_address || !form.api_username) {
      setError('Name, IP address, and username are required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        ip_address: form.ip_address,
        api_port: parseInt(form.api_port, 10) || 8728,
        api_username: form.api_username,
        ssh_port: parseInt(form.ssh_port, 10) || 22,
        ssh_username: form.ssh_username || null,
        device_type: form.device_type as DeviceType,
        notes: form.notes,
      };
      if (form.api_password) payload.api_password = form.api_password;
      if (form.ssh_password) payload.ssh_password = form.ssh_password;
      await devicesApi.update(device.id, payload);
      onSuccess();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to update device');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Edit Device
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Basic info */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Device Name *</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </div>

            <div className="col-span-2">
              <label className="label flex items-center justify-between">
                <span>Management IP *</span>
                {device.status !== 'online' && (
                  <span className="text-[10px] font-normal text-gray-400 dark:text-slate-500 normal-case tracking-normal">
                    Device offline — IP list unavailable, enter manually
                  </span>
                )}
              </label>
              <input
                className="input"
                value={form.ip_address}
                onChange={(e) => set('ip_address', e.target.value)}
                placeholder="192.168.1.1"
              />
              {device.status === 'online' && (
                <div className="mt-2 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-700/50 text-[11px] uppercase tracking-wide font-semibold text-gray-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Network className="w-3 h-3" />
                    IPs configured on this device
                  </div>
                  {ipsLoading ? (
                    <div className="px-3 py-3 text-xs text-gray-400 flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" /> Fetching from router…
                    </div>
                  ) : ipsError ? (
                    <div className="px-3 py-3 text-xs text-red-500">
                      Could not fetch IP list. You can still enter one manually.
                    </div>
                  ) : candidateIps.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-gray-400">
                      No usable IP addresses returned by the router.
                    </div>
                  ) : (
                    <ul className="max-h-40 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700">
                      {candidateIps.map((c) => {
                        const selected = form.ip_address === c.address;
                        return (
                          <li key={`${c.address}-${c.iface}`}>
                            <button
                              type="button"
                              onClick={() => set('ip_address', c.address)}
                              className={
                                'w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ' +
                                (selected
                                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                                  : 'hover:bg-gray-50 dark:hover:bg-slate-700/50 text-gray-700 dark:text-slate-300')
                              }
                            >
                              <span className="font-mono">{c.cidr}</span>
                              <span className="text-gray-400 dark:text-slate-500">{c.iface}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {!ipsLoading && !ipsError && !ipWasDetected && form.ip_address && (
                    <div className="px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400 border-t border-gray-100 dark:border-slate-700">
                      Entered IP isn&apos;t in the router&apos;s address list — double-check before saving.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="col-span-2">
              <label className="label">Device Type</label>
              <select
                className="input"
                value={form.device_type}
                onChange={(e) => set('device_type', e.target.value)}
              >
                <option value="router">Router</option>
                <option value="switch">Switch</option>
                <option value="wireless_ap">Wireless AP</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          {/* API credentials */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
              RouterOS API Credentials
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Username *</label>
                <input
                  className="input"
                  value={form.api_username}
                  onChange={(e) => set('api_username', e.target.value)}
                />
              </div>
              <div>
                <label className="label">API Port</label>
                <input
                  className="input"
                  type="number"
                  value={form.api_port}
                  onChange={(e) => set('api_port', e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <label className="label">New Password (leave blank to keep existing)</label>
                <input
                  className="input"
                  type="password"
                  value={form.api_password}
                  onChange={(e) => set('api_password', e.target.value)}
                  autoComplete="new-password"
                  placeholder="••••••••"
                />
              </div>
            </div>
          </div>

          {/* SSH credentials (optional) */}
          <details className="group">
            <summary className="cursor-pointer text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider select-none">
              SSH Credentials (optional, for backup/restore)
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="label">SSH Username</label>
                <input
                  className="input"
                  value={form.ssh_username}
                  onChange={(e) => set('ssh_username', e.target.value)}
                />
              </div>
              <div>
                <label className="label">SSH Port</label>
                <input
                  className="input"
                  type="number"
                  value={form.ssh_port}
                  onChange={(e) => set('ssh_port', e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <label className="label">New SSH Password (leave blank to keep existing)</label>
                <input
                  className="input"
                  type="password"
                  value={form.ssh_password}
                  onChange={(e) => set('ssh_password', e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
          </details>

          <div>
            <label className="label">Notes</label>
            <textarea
              className="input"
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
              <p className="text-sm text-blue-600 dark:text-blue-400">
                Verifying connection with new settings…
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="btn-primary flex items-center gap-2">
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle className="w-4 h-4" />
              )}
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
