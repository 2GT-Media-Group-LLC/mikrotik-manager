import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Power, RefreshCw, Unplug, Users } from 'lucide-react';
import clsx from 'clsx';
import { tunnelsApi, type PppServer, type PppSession, type PppUser } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import { apiErrorMessage } from '../../utils/apiError';
import ReviewChangesButton from '../common/ReviewChangesButton';

/** Rows drawn per list; the search finds the rest. */
const SHOW = 200;

/**
 * One router's PPP, live (Hector, Discussion #85): its PPPoE servers, active
 * sessions and PPP users, with server and user on/off under Change Guard and
 * disconnect for a session. Every action is in the audit log.
 */
export default function PppCard({ devices, deviceId, onDevice }: {
  devices: { id: number; name: string }[];
  deviceId: number | null;
  onDevice: (id: number | null) => void;
}) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const guard = useGuardedWrite();
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [err, setErr] = useState('');
  const device = devices.find((d) => d.id === deviceId);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['ppp', deviceId],
    queryFn: () => tunnelsApi.ppp(deviceId!).then((r) => r.data),
    enabled: deviceId != null,
    retry: false,
  });
  const done = (msg: string) => {
    setErr(''); setMessage(msg);
    void qc.invalidateQueries({ queryKey: ['ppp', deviceId] });
    void qc.invalidateQueries({ queryKey: ['tunnels'] });
  };
  const fail = (e: unknown) => { setMessage(''); setErr(apiErrorMessage(e, 'That didn’t work')); };

  const userMut = useMutation({
    mutationFn: ({ u, confirm }: { u: PppUser; confirm?: boolean }) => tunnelsApi.setUser(deviceId!, u.id, !u.disabled, confirm),
    onSuccess: (res) => { guard.onSuccess(res); done(res.data.message); },
  });
  const serverMut = useMutation({
    mutationFn: ({ v, confirm }: { v: PppServer; confirm?: boolean }) => tunnelsApi.setServer(deviceId!, v.id, !v.disabled, confirm),
    onSuccess: (res) => { guard.onSuccess(res); done(res.data.message); },
  });
  const dropMut = useMutation({
    mutationFn: ({ s, confirm }: { s: PppSession; confirm?: boolean }) => tunnelsApi.disconnect(deviceId!, s.id, s.name, confirm),
    onSuccess: (res) => done(res.data.message),
  });
  const pending = userMut.isPending || serverMut.isPending || dropMut.isPending;

  const toggleUser = (u: PppUser) =>
    userMut.mutate({ u }, { onError: guard.onError(() => userMut.mutate({ u, confirm: true }, { onError: fail }), fail) });
  const toggleServer = (v: PppServer) => {
    if (!v.disabled && !confirm(`Turn off the PPPoE server ${v.service_name} on ${v.interface ?? '?'}? Every PPPoE session on ${device?.name ?? 'the router'} `
      + `(${data?.sessions.filter((s) => s.service === 'pppoe').length ?? 0} now) ends, and nobody can dial in until it's back on.`)) return;
    serverMut.mutate({ v }, { onError: guard.onError(() => serverMut.mutate({ v, confirm: true }, { onError: fail }), fail) });
  };
  const disconnect = (s: PppSession) => {
    if (!confirm(`Disconnect ${s.name}${s.address ? ` (${s.address})` : ''}? Its client usually dials straight back in; turn the user off first to keep it out.`)) return;
    dropMut.mutate({ s }, {
      onError: (e) => {
        const managed = (e as { response?: { status?: number; data?: { managed_device?: string; error?: string } } })?.response;
        if (managed?.status === 409 && managed.data?.managed_device) {
          if (confirm(`${managed.data.error}\n\nDisconnect it anyway?`)) dropMut.mutate({ s, confirm: true }, { onError: fail });
        } else fail(e);
      },
    });
  };

  const q = search.trim().toLowerCase();
  const match = (...v: (string | null | undefined)[]) => !q || v.some((x) => (x ?? '').toLowerCase().includes(q));
  const users = useMemo(() => (data?.users ?? []).filter((u) => match(u.name, u.comment, u.profile, u.remote_address, u.last_caller_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, q]);
  const sessions = useMemo(() => (data?.sessions ?? []).filter((s) => match(s.name, s.caller_id, s.address, s.service)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, q]);

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Users className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">PPP users and sessions</h3>
        <select className="input max-w-xs text-sm py-1" value={deviceId ?? ''} aria-label="Router"
          onChange={(e) => { onDevice(e.target.value ? Number(e.target.value) : null); setMessage(''); setErr(''); }}>
          <option value="">Choose a router…</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {deviceId != null && <>
          <input className="input max-w-xs text-sm py-1" placeholder="Find a user, caller or address" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={() => void refetch()} disabled={isFetching} className="btn-secondary text-xs py-1 flex items-center gap-1 ml-auto">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Read again
          </button>
        </>}
      </div>
      {deviceId == null && (
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Read a router&rsquo;s PPP users, PPPoE servers and sessions live, to disconnect a session or turn a user or server off and on.
          Routers with PPP in the list below are offered first.
        </p>
      )}
      {message && <div className="text-xs text-green-700 dark:text-green-400">{message}</div>}
      {err && <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">{err}</div>}
      {deviceId != null && <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={device?.name} pending={pending} />}
      {deviceId != null && (isLoading ? <div className="text-sm text-gray-400">Reading the router…</div>
        : error ? <div className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(error, 'Couldn’t read the router')}</div>
          : data && <>
            {data.servers.length > 0 && (
              <section>
                <div className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">PPPoE servers</div>
                <div className="flex flex-wrap gap-2">
                  {data.servers.map((v) => (
                    <div key={v.id} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-1.5 text-xs">
                      <span className="font-mono">{v.service_name}</span>
                      <span className="text-gray-400">on {v.interface ?? '?'}</span>
                      <span className={v.disabled ? 'text-gray-400' : 'text-green-600 dark:text-green-400'}>{v.disabled ? 'off' : 'on'}</span>
                      {canWrite && <>
                        <button onClick={() => toggleServer(v)} disabled={pending} className="btn-secondary text-xs py-0.5 px-2 flex items-center gap-1">
                          <Power className="w-3 h-3" /> {v.disabled ? 'Turn on' : 'Turn off'}
                        </button>
                        <ReviewChangesButton className="text-xs py-0.5 px-2" deviceName={device?.name} disabled={pending}
                          applyLabel={v.disabled ? 'Turn on' : 'Turn off'} onApply={() => toggleServer(v)}
                          request={() => tunnelsApi.setServer(deviceId, v.id, !v.disabled)} />
                      </>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">
                Sessions ({data.sessions.length}{q ? `, ${sessions.length} match` : ''})
              </div>
              {sessions.length === 0 ? <div className="text-xs text-gray-400">{data.sessions.length ? 'None match.' : 'Nobody is connected.'}</div> : (
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-gray-500 dark:text-slate-400">
                    {['User', 'Service', 'Caller', 'Address', 'Up for', ''].map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                    {sessions.slice(0, SHOW).map((s) => (
                      <tr key={s.id}>
                        <td className="py-1 pr-3 font-mono">{s.name || '(no user)'}</td>
                        <td className="py-1 pr-3">{s.service}</td>
                        <td className="py-1 pr-3 font-mono">{s.caller_id ?? '—'}</td>
                        <td className="py-1 pr-3 font-mono">{s.address ?? '—'}</td>
                        <td className="py-1 pr-3 font-mono">{s.uptime ?? '—'}</td>
                        <td className="py-1 text-right">
                          {canWrite && <button onClick={() => disconnect(s)} disabled={pending} className="btn-secondary text-xs py-0.5 px-2 inline-flex items-center gap-1">
                            <Unplug className="w-3 h-3" /> Disconnect
                          </button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <div className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">
                Users ({data.users.length}{q ? `, ${users.length} match` : ''})
              </div>
              {users.length === 0 ? <div className="text-xs text-gray-400">{data.users.length ? 'None match.' : 'No PPP users on this router.'}</div> : (
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-gray-500 dark:text-slate-400">
                    {['User', 'Service', 'Profile', 'Status', 'Last caller', 'Last logged out', ''].map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                    {users.slice(0, SHOW).map((u) => (
                      <tr key={u.id} className={clsx(u.disabled && 'text-gray-400')}>
                        <td className="py-1 pr-3">
                          <span className="font-mono">{u.name}</span>
                          {u.comment && <div className="text-gray-400">{u.comment}</div>}
                        </td>
                        <td className="py-1 pr-3">{u.service}</td>
                        <td className="py-1 pr-3">{u.profile ?? '—'}</td>
                        <td className="py-1 pr-3">
                          {u.disabled ? 'off' : u.sessions > 0 ? <span className="text-green-600 dark:text-green-400">connected{u.sessions > 1 ? ` ×${u.sessions}` : ''}</span> : 'not connected'}
                        </td>
                        <td className="py-1 pr-3 font-mono">{u.last_caller_id ?? '—'}</td>
                        <td className="py-1 pr-3" title={u.last_disconnect_reason ?? undefined}>{u.last_logged_out ?? '—'}</td>
                        <td className="py-1 text-right">
                          {canWrite && <button onClick={() => toggleUser(u)} disabled={pending} className="btn-secondary text-xs py-0.5 px-2 inline-flex items-center gap-1"
                            title={u.disabled ? 'Let this user log in again' : 'Stop this user logging in. A session it has stays up until you disconnect it.'}>
                            <Power className="w-3 h-3" /> {u.disabled ? 'Turn on' : 'Turn off'}
                          </button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(users.length > SHOW || sessions.length > SHOW) && <div className="text-xs text-gray-400 mt-1">Showing the first {SHOW}; search to find the rest.</div>}
            </section>
          </>)}
    </div>
  );
}
