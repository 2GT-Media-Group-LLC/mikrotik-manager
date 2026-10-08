import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserCheck, RefreshCw, AlertTriangle, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { userManagerApi, type UmRow } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';

/**
 * User Manager, RouterOS's RADIUS server (#251): who's logged in where, the
 * users and groups (with the RADIUS attributes the firewalls and switches
 * authorise on), and the devices that authenticate against it. Read live from
 * the device; passwords and shared secrets never reach the browser.
 */

const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;

const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

function bytes(v: string | undefined): string {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

/** "Mikrotik-Group:full,Cisco-AVPair:shell:priv-lvl=15" as name: value chips. */
function Attributes({ value }: { value: string | undefined }) {
  const attrs = (value || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (attrs.length === 0) return <span className="text-gray-400 dark:text-slate-500">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {attrs.map((a, i) => {
        const at = a.indexOf(':');
        return (
          <span key={i} className="inline-flex rounded bg-gray-100 dark:bg-slate-700/60 px-1.5 py-0.5 font-mono text-[11px]">
            <span className="text-gray-500 dark:text-slate-400">{at < 0 ? a : a.slice(0, at)}</span>
            {at >= 0 && <span className="ml-1 text-gray-800 dark:text-slate-200">{a.slice(at + 1)}</span>}
          </span>
        );
      })}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-700 text-sm font-semibold text-gray-900 dark:text-white">
        {title}{count !== undefined && <span className="ml-2 font-normal text-gray-500 dark:text-slate-400">{count}</span>}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

const th = 'table-header px-4 py-2 text-left';
const td = 'px-4 py-2 text-xs text-gray-700 dark:text-slate-300 align-top';

export default function UserManagerPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const { data: list, isLoading: listLoading } = useQuery({
    queryKey: ['user-manager-servers'],
    queryFn: () => userManagerApi.servers().then((r) => r.data),
  });
  const servers = list?.servers ?? [];
  const chosen = Number(params.get('device')) || servers[0]?.id || null;
  useEffect(() => {
    if (!params.get('device') && servers[0]) setParams({ device: String(servers[0].id) }, { replace: true });
  }, [params, servers, setParams]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['user-manager', chosen],
    queryFn: () => userManagerApi.get(chosen!).then((r) => r.data),
    enabled: chosen != null,
    refetchInterval: 60_000,
  });

  const [confirm, setConfirm] = useState<UmRow | null>(null);
  const remove = useMutation({
    meta: { inlineError: true },
    mutationFn: (sid: string) => userManagerApi.removeSession(chosen!, sid),
    onSuccess: () => { setConfirm(null); qc.invalidateQueries({ queryKey: ['user-manager', chosen] }); },
  });
  const recheck = useMutation({
    mutationFn: () => userManagerApi.recheck(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-manager-servers'] }),
  });

  const nasName = (ip: string | undefined) => {
    const r = data?.routers.find((x) => (x.row['address'] || '').split('/')[0] === ip);
    return r ? (r.managed_device ? <Link className="text-blue-600 dark:text-blue-400 hover:underline" to={`/devices/${r.managed_device.id}`}>{r.row['name']}</Link> : r.row['name']) : null;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/20"><UserCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400" /></div>
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">User Manager</h1>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              RADIUS logins across the network: who&apos;s logged in where, users and groups with their attributes, and the devices that check against it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {servers.length > 1 && (
            <select className="input text-sm" value={chosen ?? ''} onChange={(e) => setParams({ device: e.target.value })}>
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.ip_address})</option>)}
            </select>
          )}
          {chosen != null && (
            <button className="btn-secondary p-2" title="Read it again" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={clsx('w-4 h-4', isFetching && 'animate-spin')} />
            </button>
          )}
        </div>
      </div>

      {!listLoading && servers.length === 0 && (
        <div className="card p-6 text-sm text-gray-600 dark:text-slate-300 space-y-2">
          <p className="font-semibold text-gray-900 dark:text-white">No device runs User Manager</p>
          <p>
            Each device is checked once a day for User Manager (the <span className="font-mono">user-manager</span> package, enabled).
            {list && list.unchecked > 0 && ` ${list.unchecked} haven't been checked yet.`}
          </p>
          {canWrite && (
            <button className="btn-secondary text-sm" disabled={recheck.isPending || recheck.isSuccess} onClick={() => recheck.mutate()}>
              {recheck.isSuccess ? 'Checking on the next poll (within 5 minutes)' : 'Look again now'}
            </button>
          )}
        </div>
      )}

      {isLoading && chosen != null && <div className="text-sm text-gray-400">Reading User Manager…</div>}
      {isError && (
        <div className="card p-4 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />{errText(error, 'Couldn’t read User Manager')}
        </div>
      )}

      {data && (
        <>
          <div className="card p-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div><span className="text-gray-500 dark:text-slate-400">Server </span><Link className="text-blue-600 dark:text-blue-400 hover:underline" to={`/devices/${data.device.id}`}>{data.device.name}</Link></div>
            <div><span className="text-gray-500 dark:text-slate-400">Status </span>{isTrue(data.settings['enabled']) ? <span className="text-green-600 dark:text-green-400">enabled</span> : <span className="text-amber-600">disabled</span>}</div>
            <div><span className="text-gray-500 dark:text-slate-400">Ports </span><span className="font-mono">{data.settings['authentication-port'] || '1812'} / {data.settings['accounting-port'] || '1813'}</span></div>
            {data.settings['certificate'] && data.settings['certificate'] !== 'none' && (
              <div><span className="text-gray-500 dark:text-slate-400">Certificate </span><span className="font-mono">{data.settings['certificate']}</span></div>
            )}
            <div><span className="text-gray-500 dark:text-slate-400">Users </span>{data.users.length}</div>
            <div><span className="text-gray-500 dark:text-slate-400">Devices </span>{data.routers.length}</div>
          </div>

          <Section title="Logged in now" count={data.sessions.active.length}>
            {data.sessions.active.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500 dark:text-slate-400">No active sessions.</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                  <th className={th}>User</th><th className={th}>Device</th><th className={th}>From</th><th className={th}>Started</th>
                  <th className={th}>Uptime</th><th className={th}>Down / Up</th>{canWrite && <th className={th} />}
                </tr></thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                  {data.sessions.active.map((s) => (
                    <tr key={s['.id']}>
                      <td className={clsx(td, 'font-medium')}>{s['user']}</td>
                      <td className={td}>{nasName(s['nas-ip-address']) ?? s['nas-identifier'] ?? '—'}<div className="font-mono text-gray-400">{s['nas-ip-address']}</div></td>
                      <td className={clsx(td, 'font-mono')}>{s['calling-station-id'] || '—'}</td>
                      <td className={td}>{s['started'] || '—'}</td>
                      <td className={td}>{s['uptime'] || '—'}</td>
                      <td className={td}>{bytes(s['download'])} / {bytes(s['upload'])}</td>
                      {canWrite && (
                        <td className={clsx(td, 'text-right')}>
                          <button className="text-xs text-red-600 dark:text-red-400 hover:underline inline-flex items-center gap-1"
                            title="Clear a session the device never closed" onClick={() => { remove.reset(); setConfirm(s); }}>
                            <Trash2 className="w-3.5 h-3.5" />Clear
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {confirm && (
              <div className="m-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm space-y-2">
                <p>
                  Clear <span className="font-semibold">{confirm['user']}</span>&apos;s session from {confirm['nas-ip-address'] || 'its device'}?
                  This removes the session record in User Manager, for one left open because the device never reported the logout.
                  It doesn&apos;t log the user off the device itself.
                </p>
                <div className="flex items-center gap-3">
                  <button className="btn-primary text-sm bg-red-600 hover:bg-red-700" disabled={remove.isPending} onClick={() => remove.mutate(confirm['.id'])}>
                    {remove.isPending ? 'Clearing…' : 'Clear session'}
                  </button>
                  <button className="text-sm text-gray-500 hover:underline" onClick={() => setConfirm(null)}>Cancel</button>
                  {remove.isError && <span className="text-xs text-red-600">{errText(remove.error, 'That didn’t work')}</span>}
                </div>
              </div>
            )}
          </Section>

          <Section title="Users" count={data.users.length}>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                <th className={th}>Name</th><th className={th}>Group</th><th className={th}>Shared sessions</th><th className={th}>Own attributes</th><th className={th}>Comment</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {data.users.map((u) => (
                  <tr key={u['.id'] || u['name']} className={clsx(isTrue(u['disabled']) && 'opacity-50')}>
                    <td className={clsx(td, 'font-medium')}>{u['name']}{isTrue(u['disabled']) && <span className="ml-2 text-gray-400">disabled</span>}</td>
                    <td className={td}>{u['group'] || '—'}</td>
                    <td className={td}>{u['shared-users'] || '—'}</td>
                    <td className={td}><Attributes value={u['attributes']} /></td>
                    <td className={td}>{u['comment'] || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Groups" count={data.groups.length}>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                <th className={th}>Name</th><th className={th}>Attributes sent</th><th className={th}>Methods</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {data.groups.map((g) => (
                  <tr key={g['.id'] || g['name']}>
                    <td className={clsx(td, 'font-medium whitespace-nowrap')}>{g['name']}{isTrue(g['default']) && <span className="ml-2 text-gray-400">built-in</span>}</td>
                    <td className={td}><Attributes value={g['attributes']} /></td>
                    <td className={clsx(td, 'text-gray-500 dark:text-slate-400')}>{g['outer-auths'] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Devices that authenticate against it" count={data.routers.length}>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                <th className={th}>Name</th><th className={th}>Address</th><th className={th}>In the manager</th><th className={th}>Protocol</th><th className={th}>CoA port</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {data.routers.map(({ row: r, managed_device: m }) => (
                  <tr key={r['.id'] || r['name']} className={clsx(isTrue(r['disabled']) && 'opacity-50')}>
                    <td className={clsx(td, 'font-medium')}>{r['name']}</td>
                    <td className={clsx(td, 'font-mono')}>{r['address']}</td>
                    <td className={td}>{m ? <Link className="text-blue-600 dark:text-blue-400 hover:underline" to={`/devices/${m.id}`}>{m.name}</Link> : <span className="text-gray-400">not managed</span>}</td>
                    <td className={td}>{r['protocol'] || '—'}</td>
                    <td className={td}>{r['coa-port'] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {data.sessions.recent.length > 0 && (
            <Section title="Recent sessions" count={data.sessions.recent.length}>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100 dark:border-slate-700">
                  <th className={th}>User</th><th className={th}>Device</th><th className={th}>From</th><th className={th}>Started</th><th className={th}>Ended</th><th className={th}>Why</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                  {data.sessions.recent.map((s) => (
                    <tr key={s['.id']}>
                      <td className={td}>{s['user']}</td>
                      <td className={td}>{nasName(s['nas-ip-address']) ?? s['nas-ip-address'] ?? '—'}</td>
                      <td className={clsx(td, 'font-mono')}>{s['calling-station-id'] || '—'}</td>
                      <td className={td}>{s['started'] || '—'}</td>
                      <td className={td}>{s['ended'] || '—'}</td>
                      <td className={td}>{s['terminate-cause'] || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
