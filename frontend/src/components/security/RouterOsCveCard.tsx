import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bug, RefreshCw, ChevronRight, ExternalLink, ShieldCheck, Flame } from 'lucide-react';
import clsx from 'clsx';
import { cvesApi, type FleetCve } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';

/**
 * Known vulnerabilities for the RouterOS versions in the fleet (#175).
 *
 * From NIST's NVD, with CISA's "known exploited" list marked, fetched daily by
 * the manager. A match means the version is listed as affected; many CVEs also
 * need a particular service reachable, which is why each one links to its
 * write-up.
 */

const SEVERITY_LOOK = new Map<string, string>([
  ['CRITICAL', 'bg-red-600 text-white'],
  ['HIGH', 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'],
  ['MEDIUM', 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'],
  ['LOW', 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300'],
]);

function SeverityPill({ c }: { c: FleetCve }) {
  const sev = (c.severity ?? '').toUpperCase();
  return (
    <span className={clsx('text-[11px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap', SEVERITY_LOOK.get(sev) ?? SEVERITY_LOOK.get('LOW'))}>
      {sev || 'UNRATED'}{c.score !== null ? ` ${c.score.toFixed(1)}` : ''}
    </span>
  );
}

export default function RouterOsCveCard() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['routeros-cves'],
    queryFn: () => cvesApi.report().then((r) => r.data),
  });
  const refresh = useMutation({
    mutationFn: () => cvesApi.refresh().then((r) => r.data),
    onSuccess: (d) => { qc.setQueryData(['routeros-cves'], d); setError(''); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not refresh'),
  });

  const toggle = (v: string) => setOpen((s) => { const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n; });
  const sureOf = (v: { cves: FleetCve[] }) => v.cves.filter((c) => !c.uncertain);
  const affected = data?.versions.filter((v) => sureOf(v).length > 0) ?? [];
  const exploitedDevices = new Set(
    (data?.versions ?? []).filter((v) => v.cves.some((c) => c.known_exploited)).flatMap((v) => v.devices.map((d) => d.id))
  ).size;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2 flex-wrap">
        <Bug className="w-4 h-4 text-red-500" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">RouterOS vulnerabilities</h2>
        {data && data.enabled && (
          <span className="text-xs text-gray-400 dark:text-slate-500">
            {affected.length === 0
              ? `none known for the ${data.versions.length} version${data.versions.length === 1 ? '' : 's'} in use`
              : `${affected.length} of ${data.versions.length} versions in use have known CVEs`}
            {exploitedDevices > 0 && ` · ${exploitedDevices} device${exploitedDevices === 1 ? '' : 's'} on a version attackers are exploiting`}
          </span>
        )}
        {canWrite && data?.enabled && (
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}
                  className="ml-auto flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200">
            <RefreshCw className={clsx('w-3.5 h-3.5', refresh.isPending && 'animate-spin')} /> Check now
          </button>
        )}
      </div>

      {isLoading && <p className="px-5 py-4 text-sm text-gray-400">Loading…</p>}

      {data && !data.enabled && (
        <p className="px-5 py-4 text-sm text-gray-500 dark:text-slate-400">
          Turned off in <Link to="/settings" className="text-blue-600 hover:underline">Dark Site Mode</Link>, so the list
          of known vulnerabilities isn&apos;t downloaded.
        </p>
      )}

      {data?.enabled && !data.fetched_at && (
        <p className="px-5 py-4 text-sm text-gray-500 dark:text-slate-400">
          {data.last_error ? `The list couldn't be downloaded yet: ${data.last_error}.` : 'The list hasn’t been downloaded yet; it is fetched once a day.'}
          {canWrite && ' Use Check now to fetch it.'}
        </p>
      )}

      {error && <p className="px-5 pt-3 text-sm text-red-600">{error}</p>}

      {data?.enabled && data.fetched_at && (
        <div className="divide-y divide-gray-100 dark:divide-slate-700/60">
          {data.versions.map((v) => {
            const isOpen = open.has(v.version);
            const sure = sureOf(v);
            const unsure = v.cves.length - sure.length;
            const exploited = sure.filter((c) => c.known_exploited).length;
            const expandable = v.cves.length > 0 || v.corrected.length > 0;
            return (
              <div key={v.version}>
                <button onClick={() => expandable && toggle(v.version)}
                        className={clsx('w-full px-5 py-2.5 flex items-center gap-3 text-left', expandable && 'hover:bg-gray-50 dark:hover:bg-slate-700/30')}>
                  <ChevronRight className={clsx('w-4 h-4 text-gray-400 transition-transform', isOpen && 'rotate-90', !expandable && 'invisible')} />
                  <span className="mono text-sm font-medium text-gray-900 dark:text-white w-28">{v.version}</span>
                  <span className="text-xs text-gray-500 dark:text-slate-400 w-24">
                    {v.devices.length} device{v.devices.length === 1 ? '' : 's'}
                  </span>
                  {sure.length === 0 ? (
                    <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                      <ShieldCheck className="w-3.5 h-3.5" /> No known CVEs
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-xs text-gray-700 dark:text-slate-300 flex-wrap">
                      {sure.length} CVE{sure.length === 1 ? '' : 's'}
                      {exploited > 0 && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-600 text-white text-[11px] font-medium">
                          <Flame className="w-3 h-3" /> {exploited} actively exploited
                        </span>
                      )}
                      <SeverityPill c={sure[0]} />
                    </span>
                  )}
                  {unsure > 0 && (
                    <span className="text-xs text-gray-400 dark:text-slate-500">
                      + {unsure} that may not apply
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="px-5 pb-3 pl-12 space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {v.devices.map((d) => (
                        <Link key={d.id} to={`/devices/${d.id}`} className="mono text-[11px] px-1.5 py-0.5 rounded hover:underline"
                              style={{ background: 'var(--surface-2)', color: 'var(--ink-2)' }}>{d.name}</Link>
                      ))}
                    </div>
                    {v.cves.map((c) => (
                      <div key={c.id} className={clsx('text-sm', c.uncertain && 'opacity-60')}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <a href={`https://nvd.nist.gov/vuln/detail/${c.id}`} target="_blank" rel="noopener noreferrer"
                             className="mono font-medium text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                            {c.id} <ExternalLink className="w-3 h-3" />
                          </a>
                          <SeverityPill c={c} />
                          {c.known_exploited && (
                            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-600 text-white text-[11px] font-medium">
                              <Flame className="w-3 h-3" /> Actively exploited
                            </span>
                          )}
                          {c.fixed_in && <span className="text-xs text-green-700 dark:text-green-400">Fixed in {c.fixed_in}</span>}
                          {c.hardware_specific && <span className="text-xs text-gray-400">Only on some hardware</span>}
                        </div>
                        {c.uncertain && (
                          <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">May not apply: {c.uncertain}.</p>
                        )}
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 line-clamp-2">{c.summary}</p>
                      </div>
                    ))}
                    {v.corrected.map((c) => (
                      <p key={c.id} className="text-xs text-gray-400 dark:text-slate-500">
                        Not shown: <span className="mono">{c.id}</span>. NVD lists it for this version, but {c.reason}.
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="px-5 py-2.5 text-[11px] text-gray-400 dark:text-slate-500">
            From NIST&apos;s National Vulnerability Database, with CISA&apos;s list of actively exploited ones; checked{' '}
            {new Date(data.fetched_at).toLocaleString()}. Matched by version only: many need a particular service
            (SSH, winbox, btest) reachable, so read each one before acting.
            {data.unranged > 0 && ` ${data.unranged} CVE${data.unranged === 1 ? ' is' : 's are'} listed without a version range and can’t be matched.`}
          </p>
        </div>
      )}
    </div>
  );
}
