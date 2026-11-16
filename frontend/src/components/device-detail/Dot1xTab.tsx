import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldCheck, Plus, Pencil, Trash2, RefreshCw, Loader2, Power, X } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type Dot1xMenu } from '../../services/api';
import { apiErrorMessage } from '../../utils/apiError';
import { LockoutVerdictDialog, lockoutVerdictOf, guardOutcomeMessage, type LockoutVerdict, type GuardResult } from '../ChangeGuardDialog';
import ReviewChangesButton from '../common/ReviewChangesButton';

/**
 * 802.1X on one device (#360): ports that authenticate clients (with the VLANs
 * for guests, rejects and a silent RADIUS server), who's authenticated now,
 * the RADIUS servers asked, and the device's own supplicant on an uplink.
 * Turning 802.1X on blocks a port until something authenticates, so the
 * change runs under Change Guard and asks first on the management port.
 */

const s = (v: string | boolean | undefined) => (typeof v === 'string' ? v : '');
const isOn = (v: string | boolean | undefined) => v === true || v === 'true' || v === 'yes';
const seconds = (v: string | boolean | undefined): string => {
  // RouterOS times: "30s", "1m", "1h30m" → seconds.
  const t = s(v);
  if (!t) return '';
  let total = 0;
  for (const [, n, u] of t.matchAll(/(\d+)([wdhms])/g)) total += Number(n) * ({ w: 604800, d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[u];
  return total ? String(total) : '';
};

interface ServerForm { id?: string; interface: string; dot1x: boolean; mac: boolean; guest: string; reject: string; fail: string; retrans: string; reauth: string; macMode: string; accounting: boolean; comment: string }
interface RadiusForm { id?: string; address: string; secret: string; timeout: string; comment: string; hasSecret: boolean }
interface ClientForm { id?: string; interface: string; methods: string[]; identity: string; password: string; certificate: string; comment: string; hasPassword: boolean }

const STATUS_STYLE: Record<string, string> = {
  authorized: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  'un-authorized': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  'rejected-holding': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  'iface-down': 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400',
};

function vlanError(v: string): string | null {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 4094 ? null : '1 to 4094';
}
const vlanOrNull = (v: string) => (v.trim() ? Number(v) : null);

export default function Dot1xTab({ deviceId, deviceName, canWrite }: { deviceId: number; deviceName: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['dot1x', deviceId],
    queryFn: () => devicesApi.getDot1x(deviceId).then((r) => r.data),
    refetchInterval: 30_000,
  });
  const { data: ifaces = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data),
  });
  const ports = ifaces.filter((i) => ['ether', 'bond', 'wlan', 'wifi'].includes(String(i.type))).map((i) => String(i.name));

  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);
  const [server, setServer] = useState<ServerForm | null>(null);
  const [radius, setRadius] = useState<RadiusForm | null>(null);
  const [client, setClient] = useState<ClientForm | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const done = (r: { data?: { message?: string; guard?: GuardResult } }) => {
    const g = guardOutcomeMessage(r.data?.guard);
    setNote(g ? { ok: g.tone === 'ok', text: g.text } : { ok: true, text: r.data?.message || 'Saved' });
    setLockout(null); setServer(null); setRadius(null); setClient(null); setConfirmRemove(null);
    void qc.invalidateQueries({ queryKey: ['dot1x', deviceId] });
  };
  const write = useMutation({
    mutationFn: (w: { op: 'add' | 'set' | 'remove'; menu: Dot1xMenu; id?: string; body?: Record<string, unknown>; iface?: string; confirm?: boolean }) =>
      w.op === 'add' ? devicesApi.addDot1x(deviceId, w.menu, w.body ?? {}, w.confirm)
        : w.op === 'set' ? devicesApi.updateDot1x(deviceId, w.menu, w.id!, w.body ?? {}, w.confirm)
          : devicesApi.removeDot1x(deviceId, w.menu, w.id!, w.iface, w.confirm),
    onSuccess: done,
    onError: (e, w) => {
      const verdict = lockoutVerdictOf(e);
      if (verdict) { setLockout({ verdict, retry: () => write.mutate({ ...w, confirm: true }) }); return; }
      setNote({ ok: false, text: apiErrorMessage(e) });
    },
  });

  // ── Bodies ──
  const serverBody = (f: ServerForm): Record<string, unknown> => ({
    interface: f.interface,
    auth_types: [...(f.dot1x ? ['dot1x'] : []), ...(f.mac ? ['mac-auth'] : [])],
    guest_vlan_id: vlanOrNull(f.guest), reject_vlan_id: vlanOrNull(f.reject), server_fail_vlan_id: vlanOrNull(f.fail),
    retrans_timeout: Number(f.retrans) || 30, reauth_timeout: f.reauth.trim() ? Number(f.reauth) : null,
    accounting: f.accounting, comment: f.comment,
    ...(f.mac ? { mac_auth_mode: f.macMode } : {}),
  });
  const serverErrors = (f: ServerForm) => ({
    interface: !f.interface ? 'Choose a port' : null,
    types: !f.dot1x && !f.mac ? 'Choose at least one' : null,
    guest: vlanError(f.guest) ?? (f.guest.trim() && f.mac ? 'Not with MAC authentication: devices without 802.1X use that instead' : null),
    reject: vlanError(f.reject), fail: vlanError(f.fail),
    retrans: !/^\d+$/.test(f.retrans) || Number(f.retrans) < 1 || Number(f.retrans) > 3600 ? '1 to 3600 seconds' : null,
    reauth: f.reauth.trim() && (!/^\d+$/.test(f.reauth) || Number(f.reauth) < 60 || Number(f.reauth) > 604800) ? '60 seconds to 7 days, or empty for never' : null,
  });
  const radiusBody = (f: RadiusForm): Record<string, unknown> => ({
    address: f.address.trim(), service: ['dot1x'], ...(f.secret ? { secret: f.secret } : {}),
    ...(f.timeout.trim() ? { timeout: Number(f.timeout) } : {}), comment: f.comment,
  });
  const radiusErrors = (f: RadiusForm) => ({
    address: !/^[0-9A-Fa-f.:]{2,45}$/.test(f.address.trim()) ? 'An IP address' : null,
    secret: !f.secret && !f.hasSecret ? 'Enter the shared secret' : null,
    timeout: f.timeout.trim() && (!/^\d+$/.test(f.timeout) || Number(f.timeout) < 100 || Number(f.timeout) > 60000) ? '100 to 60000 ms' : null,
  });
  const clientBody = (f: ClientForm): Record<string, unknown> => ({
    interface: f.interface, eap_methods: f.methods, identity: f.identity, comment: f.comment,
    ...(f.password ? { password: f.password } : {}), ...(f.certificate ? { client_certificate: f.certificate } : {}),
  });
  const clientErrors = (f: ClientForm) => ({
    interface: !f.interface ? 'Choose a port' : null,
    methods: f.methods.length === 0 ? 'Choose at least one' : null,
    certificate: f.methods.includes('eap-tls') && !f.certificate ? 'EAP-TLS needs a client certificate' : null,
  });

  if (isLoading) return <div className="card p-6 text-sm text-gray-400">Loading 802.1X…</div>;
  if (error || !data) return <div className="card p-6 text-sm text-red-500">{apiErrorMessage(error, 'Couldn’t read 802.1X')}</div>;
  if (!data.supported) {
    return <div className="card p-6 text-sm text-gray-500 dark:text-slate-400">This device doesn&apos;t support 802.1X (RouterOS leaves it out on SMIPS devices such as the hAP lite and hAP mini).</div>;
  }
  const stateOf = (iface: string) => s(data.state.find((r) => r.interface === iface)?.status);
  const field = (label: string, err: string | null, input: React.ReactNode, help?: string) => (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">{label}</span>
      {input}
      {err ? <span className="block text-[11.5px] text-red-600 dark:text-red-400 mt-0.5">{err}</span>
        : help && <span className="block text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">{help}</span>}
    </label>
  );
  const busy = write.isPending;
  const removeButtons = (key: string, menu: Dot1xMenu, id: string, iface?: string) => canWrite && (
    confirmRemove === key ? (
      <span className="inline-flex items-center gap-1">
        <button type="button" className="btn-danger text-xs px-2 py-1" disabled={busy} onClick={() => write.mutate({ op: 'remove', menu, id, iface })}>Remove</button>
        <button type="button" className="text-xs text-gray-500 px-1" onClick={() => setConfirmRemove(null)}>Keep</button>
      </span>
    ) : (
      <button type="button" className="p-1.5 text-gray-400 hover:text-red-600" title="Remove" onClick={() => setConfirmRemove(key)}><Trash2 className="w-3.5 h-3.5" /></button>
    )
  );

  const se = server ? serverErrors(server) : null;
  const re = radius ? radiusErrors(radius) : null;
  const ce = client ? clientErrors(client) : null;

  return (
    <div className="space-y-4">
      <div className="card p-4 flex items-start gap-3">
        <ShieldCheck className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-gray-600 dark:text-slate-300 flex-1">
          Ports with 802.1X pass nothing until a device authenticates against a RADIUS server, such as{' '}
          <Link to="/user-manager" className="underline">User Manager</Link>, which can link this device for you. VLANs
          assigned by RADIUS, and the guest, reject and server-fail VLANs, need VLAN filtering on the bridge.
        </div>
        <button type="button" className="btn-secondary px-2" title="Refresh" onClick={() => refetch()}>
          <RefreshCw className={clsx('w-4 h-4', isFetching && 'animate-spin')} />
        </button>
      </div>
      {note && (
        <div className={clsx('p-3 rounded-lg text-sm flex items-start gap-2', note.ok ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400' : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400')}>
          <span className="flex-1">{note.text}</span>
          <button type="button" onClick={() => setNote(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Authenticating ports ── */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-100 flex-1">Ports That Authenticate</h3>
          {canWrite && !server && (
            <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => setServer({ interface: '', dot1x: true, mac: false, guest: '', reject: '', fail: '', retrans: '30', reauth: '', macMode: 'mac-as-username', accounting: true, comment: '' })}>
              <Plus className="w-3.5 h-3.5" />Add a port
            </button>
          )}
        </div>
        {data.servers.length === 0 && !server && <div className="p-4 text-sm text-gray-400">No port uses 802.1X.</div>}
        {data.servers.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                {['Port', 'State', 'Methods', 'Guest / reject / server down', 'Comment', ''].map((h) => <th key={h} className="table-header px-3 py-2 text-left">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {data.servers.map((r) => {
                  const st = isOn(r.disabled) ? 'disabled' : stateOf(r.interface);
                  return (
                    <tr key={r['.id']}>
                      <td className="px-3 py-2 font-mono">{r.interface}</td>
                      <td className="px-3 py-2"><span className={clsx('px-1.5 py-0.5 rounded text-xs', STATUS_STYLE[st] ?? 'bg-gray-100 text-gray-500 dark:bg-slate-700')}>{st || '—'}</span></td>
                      <td className="px-3 py-2 text-xs">{(r['auth-types'] || '').replace('mac-auth', 'MAC')}</td>
                      <td className="px-3 py-2 text-xs font-mono">{[r['guest-vlan-id'], r['reject-vlan-id'], r['server-fail-vlan-id']].map((v) => v || '–').join(' / ')}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{r.comment}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {canWrite && (
                          <>
                            <button type="button" className="p-1.5 text-gray-400 hover:text-blue-600" title={isOn(r.disabled) ? 'Turn on' : 'Turn off'} disabled={busy}
                              onClick={() => write.mutate({ op: 'set', menu: 'servers', id: r['.id'], body: { interface: r.interface, disabled: !isOn(r.disabled) } })}>
                              <Power className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit" onClick={() => setServer({
                              id: r['.id'], interface: r.interface, dot1x: (r['auth-types'] || '').includes('dot1x'), mac: (r['auth-types'] || '').includes('mac-auth'),
                              guest: r['guest-vlan-id'] || '', reject: r['reject-vlan-id'] || '', fail: r['server-fail-vlan-id'] || '',
                              retrans: seconds(r['retrans-timeout']) || '30', reauth: seconds(r['reauth-period'] || r['reauth-timeout']),
                              macMode: r['mac-auth-mode'] || 'mac-as-username', accounting: r.accounting !== 'false', comment: r.comment || '',
                            })}><Pencil className="w-3.5 h-3.5" /></button>
                          </>
                        )}
                        {removeButtons(`s${r['.id']}`, 'servers', r['.id'], r.interface)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {server && se && (
          <div className="p-4 border-t border-gray-100 dark:border-slate-700 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('Port', se.interface,
                <select className="input w-full" value={server.interface} disabled={!!server.id} onChange={(e) => setServer({ ...server, interface: e.target.value })}>
                  <option value="">Choose…</option>
                  {ports.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>)}
              {field('Methods', se.types,
                <div className="flex gap-3 text-sm pt-1.5">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={server.dot1x} onChange={(e) => setServer({ ...server, dot1x: e.target.checked })} />802.1X</label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={server.mac} onChange={(e) => setServer({ ...server, mac: e.target.checked })} />MAC address</label>
                </div>, 'With both, MAC is tried after three unanswered 802.1X attempts')}
              {field('Retry every (seconds)', se.retrans, <input className="input w-full" inputMode="numeric" value={server.retrans} onChange={(e) => setServer({ ...server, retrans: e.target.value })} />)}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('Guest VLAN', se.guest, <input className="input w-full" inputMode="numeric" value={server.guest} placeholder="None" onChange={(e) => setServer({ ...server, guest: e.target.value })} />, 'For devices that don’t do 802.1X')}
              {field('Reject VLAN', se.reject, <input className="input w-full" inputMode="numeric" value={server.reject} placeholder="None" onChange={(e) => setServer({ ...server, reject: e.target.value })} />, 'When RADIUS says no')}
              {field('Server down VLAN', se.fail, <input className="input w-full" inputMode="numeric" value={server.fail} placeholder="None" onChange={(e) => setServer({ ...server, fail: e.target.value })} />, 'When RADIUS doesn’t answer')}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('Re-authenticate every (seconds)', se.reauth, <input className="input w-full" inputMode="numeric" value={server.reauth} placeholder="Never" onChange={(e) => setServer({ ...server, reauth: e.target.value })} />)}
              {server.mac && field('MAC authentication sends', null,
                <select className="input w-full" value={server.macMode} onChange={(e) => setServer({ ...server, macMode: e.target.value })}>
                  <option value="mac-as-username">MAC as the username</option>
                  <option value="mac-as-username-and-password">MAC as username and password</option>
                </select>)}
              {field('Comment', null, <input className="input w-full" maxLength={255} value={server.comment} onChange={(e) => setServer({ ...server, comment: e.target.value })} />)}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300"><input type="checkbox" checked={server.accounting} onChange={(e) => setServer({ ...server, accounting: e.target.checked })} />Send RADIUS accounting</label>
            <p className="text-xs text-amber-700 dark:text-amber-400">The port passes nothing until a device authenticates. On the port this device is managed through, Change Guard asks first and arms auto-revert.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-primary flex items-center gap-1.5" disabled={Object.values(se).some(Boolean) || busy}
                onClick={() => write.mutate(server.id ? { op: 'set', menu: 'servers', id: server.id, body: serverBody(server) } : { op: 'add', menu: 'servers', body: serverBody(server) })}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}Save
              </button>
              <ReviewChangesButton deviceName={deviceName} disabled={Object.values(se).some(Boolean) || busy} applyLabel="Save"
                request={() => (server.id ? devicesApi.updateDot1x(deviceId, 'servers', server.id, serverBody(server)) : devicesApi.addDot1x(deviceId, 'servers', serverBody(server)))}
                onApply={() => write.mutate(server.id ? { op: 'set', menu: 'servers', id: server.id, body: serverBody(server) } : { op: 'add', menu: 'servers', body: serverBody(server) })} />
              <button type="button" className="text-sm text-gray-500 hover:underline" onClick={() => setServer(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Authenticated now ── */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-100">Authenticated Now</h3>
        </div>
        {data.active.length === 0 ? <div className="p-4 text-sm text-gray-400">Nobody is authenticated.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                {['Port', 'Device', 'User', 'How', 'VLAN'].map((h) => <th key={h} className="table-header px-3 py-2 text-left">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {data.active.map((r) => (
                  <tr key={r['.id'] || `${r.interface}-${r['client-mac']}`}>
                    <td className="px-3 py-2 font-mono">{r.interface}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r['client-mac'] ? <Link className="underline" to={`/clients/${encodeURIComponent(r['client-mac'].toLowerCase())}`}>{r['client-mac']}</Link> : '—'}
                    </td>
                    <td className="px-3 py-2">{r.username || '—'}</td>
                    <td className="px-3 py-2 text-xs">{r['auth-info'] || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r['vlan-id'] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── RADIUS servers ── */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-100 flex-1">RADIUS Servers</h3>
          {canWrite && !radius && (
            <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => setRadius({ address: '', secret: '', timeout: '', comment: '', hasSecret: false })}>
              <Plus className="w-3.5 h-3.5" />Add a server
            </button>
          )}
        </div>
        {data.radius.length === 0 && !radius && <div className="p-4 text-sm text-gray-400">No RADIUS servers. Add one, or link this device from User Manager.</div>}
        {data.radius.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                {['Address', 'Used for', 'Secret', 'Timeout', 'Comment', ''].map((h) => <th key={h} className="table-header px-3 py-2 text-left">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {data.radius.map((r) => {
                  const id = s(r['.id']);
                  return (
                    <tr key={id} className={clsx(isOn(r.disabled) && 'opacity-50')}>
                      <td className="px-3 py-2 font-mono">{s(r.address)}</td>
                      <td className="px-3 py-2 text-xs">{s(r.service).replace('dot1x', '802.1X')}</td>
                      <td className="px-3 py-2 text-xs">{r.has_secret ? 'Set' : <span className="text-amber-600">None</span>}</td>
                      <td className="px-3 py-2 text-xs">{s(r.timeout)}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{s(r.comment)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {canWrite && (
                          <button type="button" className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit"
                            onClick={() => setRadius({ id, address: s(r.address), secret: '', timeout: String(parseInt(s(r.timeout), 10) || ''), comment: s(r.comment), hasSecret: !!r.has_secret })}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {removeButtons(`r${id}`, 'radius', id)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {radius && re && (
          <div className="p-4 border-t border-gray-100 dark:border-slate-700 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('Address', re.address, <input className="input w-full font-mono" value={radius.address} onChange={(e) => setRadius({ ...radius, address: e.target.value })} placeholder="192.168.88.10" />)}
              {field('Shared secret', re.secret, <input className="input w-full" type="password" autoComplete="new-password" value={radius.secret} placeholder={radius.hasSecret ? 'Unchanged' : ''} onChange={(e) => setRadius({ ...radius, secret: e.target.value })} />)}
              {field('Timeout (ms)', re.timeout, <input className="input w-full" inputMode="numeric" value={radius.timeout} placeholder="300" onChange={(e) => setRadius({ ...radius, timeout: e.target.value })} />)}
            </div>
            {field('Comment', null, <input className="input w-full" maxLength={255} value={radius.comment} onChange={(e) => setRadius({ ...radius, comment: e.target.value })} />)}
            <div className="flex items-center gap-2">
              <button type="button" className="btn-primary flex items-center gap-1.5" disabled={Object.values(re).some(Boolean) || busy}
                onClick={() => write.mutate(radius.id ? { op: 'set', menu: 'radius', id: radius.id, body: radiusBody(radius) } : { op: 'add', menu: 'radius', body: radiusBody(radius) })}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}Save
              </button>
              <button type="button" className="text-sm text-gray-500 hover:underline" onClick={() => setRadius(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Supplicant ── */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-100">This Device Authenticating Upstream</h3>
            <p className="text-xs text-gray-400">For an uplink into a switch that requires 802.1X.</p>
          </div>
          {canWrite && !client && (
            <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => setClient({ interface: '', methods: ['eap-peap'], identity: '', password: '', certificate: '', comment: '', hasPassword: false })}>
              <Plus className="w-3.5 h-3.5" />Add
            </button>
          )}
        </div>
        {data.clients.length === 0 && !client && <div className="p-4 text-sm text-gray-400">None.</div>}
        {data.clients.map((r) => {
          const id = s(r['.id']);
          return (
            <div key={id} className="px-4 py-2 flex items-center gap-3 text-sm border-b border-gray-100 dark:border-slate-700 last:border-0">
              <span className="font-mono">{s(r.interface)}</span>
              <span className="text-xs">{s(r['eap-methods'])}</span>
              <span className="text-xs text-gray-500">{s(r.identity)}</span>
              <span className="text-xs flex-1">{s(r.status)}</span>
              {canWrite && (
                <button type="button" className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit" onClick={() => setClient({
                  id, interface: s(r.interface), methods: s(r['eap-methods']).split(',').filter(Boolean), identity: s(r.identity), password: '',
                  certificate: s(r['client-certificate']), comment: s(r.comment), hasPassword: !!r.has_password,
                })}><Pencil className="w-3.5 h-3.5" /></button>
              )}
              {removeButtons(`c${id}`, 'clients', id, s(r.interface))}
            </div>
          );
        })}
        {client && ce && (
          <div className="p-4 border-t border-gray-100 dark:border-slate-700 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {field('Port', ce.interface,
                <select className="input w-full" value={client.interface} disabled={!!client.id} onChange={(e) => setClient({ ...client, interface: e.target.value })}>
                  <option value="">Choose…</option>
                  {ports.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>)}
              {field('EAP methods', ce.methods,
                <div className="flex flex-wrap gap-3 text-sm pt-1.5">
                  {['eap-tls', 'eap-ttls', 'eap-peap', 'eap-mschapv2'].map((m) => (
                    <label key={m} className="flex items-center gap-1.5"><input type="checkbox" checked={client.methods.includes(m)}
                      onChange={(e) => setClient({ ...client, methods: e.target.checked ? [...client.methods, m] : client.methods.filter((x) => x !== m) })} />{m.replace('eap-', '').toUpperCase()}</label>
                  ))}
                </div>)}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {field('Identity', null, <input className="input w-full" maxLength={128} value={client.identity} onChange={(e) => setClient({ ...client, identity: e.target.value })} />)}
              {field('Password', null, <input className="input w-full" type="password" autoComplete="new-password" value={client.password} placeholder={client.hasPassword ? 'Unchanged' : ''} onChange={(e) => setClient({ ...client, password: e.target.value })} />)}
              {field('Client certificate', ce.certificate, <input className="input w-full" maxLength={128} value={client.certificate} placeholder="For EAP-TLS" onChange={(e) => setClient({ ...client, certificate: e.target.value })} />)}
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-400">If the switch upstream refuses, this port loses its link to it. On the port this device is managed through, Change Guard asks first and arms auto-revert.</p>
            <div className="flex items-center gap-2">
              <button type="button" className="btn-primary flex items-center gap-1.5" disabled={Object.values(ce).some(Boolean) || busy}
                onClick={() => write.mutate(client.id ? { op: 'set', menu: 'clients', id: client.id, body: clientBody(client) } : { op: 'add', menu: 'clients', body: clientBody(client) })}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}Save
              </button>
              <button type="button" className="text-sm text-gray-500 hover:underline" onClick={() => setClient(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {lockout && (
        <LockoutVerdictDialog deviceId={deviceId} verdict={lockout.verdict} confirmPhrase={deviceName || 'confirm'}
          pending={busy} onConfirm={lockout.retry} onCancel={() => setLockout(null)} />
      )}
    </div>
  );
}
