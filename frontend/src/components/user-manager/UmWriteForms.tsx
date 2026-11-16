import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Link2 } from 'lucide-react';
import { devicesApi, userManagerApi, type UmRow, type UmUserInput } from '../../services/api';
import { apiErrorMessage } from '../../utils/apiError';
import DevicePicker from '../common/DevicePicker';

/**
 * User Manager edits (#360): a user, with the VLAN RADIUS hands to an 802.1X
 * port, and linking a switch so its 802.1X asks this server.
 */

const TUNNEL = /^(Tunnel-Type|Tunnel-Medium-Type|Tunnel-Private-Group-ID):/i;

/** The VLAN a user's attributes assign, and the attributes without the three that do it. */
export function splitVlan(attributes: string | undefined): { vlan: string; rest: string } {
  const parts = (attributes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const m = parts.map((p) => /^Tunnel-Private-Group-ID:(\d{1,4})$/i.exec(p)).find(Boolean);
  return { vlan: m ? m[1] : '', rest: parts.filter((p) => !TUNNEL.test(p)).join(',') };
}

export function UmUserForm({ serverId, user, groups, onDone }: { serverId: number; user?: UmRow; groups: UmRow[]; onDone: () => void }) {
  const qc = useQueryClient();
  const split = splitVlan(user?.['attributes']);
  const [f, setF] = useState({
    name: user?.['name'] ?? '', password: '', group: user?.['group'] ?? (groups.find((g) => g['name'] === 'default')?.['name'] ?? groups[0]?.['name'] ?? 'default'),
    shared: user?.['shared-users'] ?? '1', vlan: split.vlan, attributes: split.rest,
    disabled: user?.['disabled'] === 'true', comment: user?.['comment'] ?? '',
  });
  const errors = {
    name: !f.name.trim() || f.name.length > 64 ? 'A username, up to 64 characters' : null,
    password: !user && !f.password ? 'A password' : null,
    shared: !/^\d+$/.test(f.shared) || Number(f.shared) < 1 || Number(f.shared) > 1000 ? '1 to 1000' : null,
    vlan: f.vlan.trim() && (!/^\d+$/.test(f.vlan) || Number(f.vlan) < 1 || Number(f.vlan) > 4094) ? '1 to 4094, or empty' : null,
    attributes: f.attributes.split(',').map((s) => s.trim()).filter(Boolean).some((a) => !/^[A-Za-z][A-Za-z0-9-]*:.+$/.test(a)) ? 'Name:value pairs separated by commas' : null,
  };
  const body = (): UmUserInput => ({
    name: f.name.trim(), password: f.password, group: f.group, shared_users: Number(f.shared),
    attributes: f.attributes, vlan_id: f.vlan.trim() ? Number(f.vlan) : null, disabled: f.disabled, comment: f.comment,
  });
  const save = useMutation({
    mutationFn: () => (user ? userManagerApi.updateUser(serverId, user['.id'], body()) : userManagerApi.addUser(serverId, body())),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['user-manager', serverId] }); onDone(); },
  });
  const field = (label: string, err: string | null, input: React.ReactNode, help?: string) => (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">{label}</span>
      {input}
      {err ? <span className="block text-[11.5px] text-red-600 dark:text-red-400 mt-0.5">{err}</span>
        : help && <span className="block text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">{help}</span>}
    </label>
  );
  return (
    <div className="m-3 rounded-lg border border-gray-200 dark:border-slate-700 p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {field('Username', errors.name, <input className="input w-full" value={f.name} maxLength={64} onChange={(e) => setF({ ...f, name: e.target.value })} />)}
        {field('Password', errors.password, <input className="input w-full" type="password" autoComplete="new-password" value={f.password}
          placeholder={user ? 'Unchanged' : ''} onChange={(e) => setF({ ...f, password: e.target.value })} />, user ? 'Leave empty to keep it' : undefined)}
        {field('Group', null,
          <select className="input w-full" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
            {groups.map((g) => <option key={g['.id'] || g['name']} value={g['name']}>{g['name']}</option>)}
          </select>)}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {field('VLAN for 802.1X', errors.vlan, <input className="input w-full" inputMode="numeric" value={f.vlan} placeholder="None"
          onChange={(e) => setF({ ...f, vlan: e.target.value })} />, 'The port puts this user in it')}
        {field('Sessions at once', errors.shared, <input className="input w-full" inputMode="numeric" value={f.shared} onChange={(e) => setF({ ...f, shared: e.target.value })} />)}
        {field('Comment', null, <input className="input w-full" maxLength={255} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />)}
      </div>
      {field('Other attributes', errors.attributes, <input className="input w-full font-mono text-xs" value={f.attributes} placeholder="Mikrotik-Group:read"
        onChange={(e) => setF({ ...f, attributes: e.target.value })} />, 'Name:value pairs, separated by commas')}
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300"><input type="checkbox" checked={f.disabled} onChange={(e) => setF({ ...f, disabled: e.target.checked })} />Disabled</label>
      {save.isError && <p className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(save.error)}</p>}
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary flex items-center gap-1.5" disabled={Object.values(errors).some(Boolean) || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}{user ? 'Save' : 'Add user'}
        </button>
        <button type="button" className="text-sm text-gray-500 hover:underline" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

const ipOk = (v: string) => !v.trim() || /^(\d{1,3}\.){3}\d{1,3}$/.test(v.trim()) || /^[0-9A-Fa-f:]+:[0-9A-Fa-f:]*$/.test(v.trim());

export function LinkDot1xPanel({ serverId, serverName, onDone }: { serverId: number; serverName: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [umAddress, setUmAddress] = useState('');
  const [nasAddress, setNasAddress] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: () => devicesApi.list().then((r) => r.data) });
  const switches = devices.filter((d) => d.id !== serverId && (d.device_type === 'switch' || d.device_type === 'router'));
  const link = useMutation({
    mutationFn: () => userManagerApi.linkDot1x(serverId, {
      device_id: deviceId!, ...(umAddress.trim() ? { um_address: umAddress.trim() } : {}), ...(nasAddress.trim() ? { nas_address: nasAddress.trim() } : {}),
    }).then((r) => r.data),
    onSuccess: (r) => { setResult(r.message ?? 'Linked'); void qc.invalidateQueries({ queryKey: ['user-manager', serverId] }); },
  });
  const invalid = deviceId == null || !ipOk(umAddress) || !ipOk(nasAddress);
  return (
    <div className="m-3 rounded-lg border border-gray-200 dark:border-slate-700 p-4 space-y-3 text-sm">
      <p className="text-gray-600 dark:text-slate-300">
        Have a switch&apos;s 802.1X ask {serverName}. A new shared secret is set on both: {serverName} accepts the switch,
        and the switch gets (or updates) a RADIUS server for 802.1X. Then turn 802.1X on for its ports on the switch&apos;s 802.1X tab.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Switch</span>
          <DevicePicker devices={switches} value={deviceId} onChange={(id) => setDeviceId(id)} aria-label="Switch" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Switch reaches the server at</span>
          <input className="input w-full font-mono" value={umAddress} placeholder="Its management address" onChange={(e) => setUmAddress(e.target.value)} />
          {!ipOk(umAddress) && <span className="text-[11.5px] text-red-600">An IP address</span>}
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Server sees the switch as</span>
          <input className="input w-full font-mono" value={nasAddress} placeholder="Its management address" onChange={(e) => setNasAddress(e.target.value)} />
          {!ipOk(nasAddress) && <span className="text-[11.5px] text-red-600">An IP address</span>}
        </label>
      </div>
      {result && <p className="text-green-700 dark:text-green-400">{result}</p>}
      {link.isError && <p className="text-red-600 dark:text-red-400">{apiErrorMessage(link.error)}</p>}
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary flex items-center gap-1.5" disabled={invalid || link.isPending} onClick={() => link.mutate()}>
          {link.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}Link
        </button>
        <button type="button" className="text-sm text-gray-500 hover:underline" onClick={onDone}>{result ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  );
}
