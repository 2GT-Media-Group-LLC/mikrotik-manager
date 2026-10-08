import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import LoadError from '../common/LoadError';
import { ShieldCheck, ShieldAlert, RefreshCw, Check, AlertTriangle, Lock, BellOff, Bell, KeyRound, Globe } from 'lucide-react';
import { devicesApi, type ApiSslResult } from '../../services/api';
import { activeChecks, mutedCount } from '../../utils/securityFindings';
import type { SecurityCheck } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';
import clsx from 'clsx';
import ListInput from '../common/ListInput';
import { isIpOrPrefix } from '../../utils/ipPrefix';

type Row = Record<string, string> & { '.id': string };

const SEV_STYLE: Record<string, { ring: string; text: string; label: string }> = {
  high:   { ring: 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20', text: 'text-red-600 dark:text-red-400', label: 'High' },
  medium: { ring: 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20', text: 'text-amber-600 dark:text-amber-400', label: 'Medium' },
  low:    { ring: 'border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20', text: 'text-blue-600 dark:text-blue-400', label: 'Low' },
  ok:     { ring: 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-900/20', text: 'text-green-600 dark:text-green-400', label: 'OK' },
};

function scoreColor(score: number) {
  if (score >= 85) return 'text-green-600 dark:text-green-400';
  if (score >= 60) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

export default function SecurityTab({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [serviceError, setServiceError] = useState('');
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);

  const { data: posture, isLoading, refetch, isFetching, isError: postureError, error: postureErr } = useQuery({
    queryKey: ['security-posture', deviceId],
    queryFn: () => devicesApi.getSecurityPosture(deviceId).then(r => r.data),
  });
  const { data: servicesRaw = [] } = useQuery({
    queryKey: ['services', deviceId],
    queryFn: () => devicesApi.getServices(deviceId).then(r => r.data as Row[]),
  });
  // The backend drops the live-connection rows RouterOS also prints (#192);
  // one row per name is a guard against anything left.
  const services = Array.from(new Map(servicesRaw.filter(s => s.dynamic !== 'true').map(s => [s.name ?? s['.id'], s])).values());
  // The RouterOS service the platform connects through — never let it be
  // disabled from here, or MikroTik Manager loses control of the device.
  const { data: device } = useQuery({
    queryKey: ['device', deviceId],
    queryFn: () => devicesApi.get(deviceId).then(r => r.data),
  });
  const mgmtService = device?.api_port === 8729 ? 'api-ssl' : 'api';

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['security-posture', deviceId] });
    qc.invalidateQueries({ queryKey: ['services', deviceId] });
    qc.invalidateQueries({ queryKey: ['security-suppressions'] });
  };
  // Suppression (issue #101): a heuristic the operator has judged inapplicable is
  // marked and excluded from the score rather than hidden, so posture stays auditable.
  const suppress = useMutation({
    mutationFn: ({ checkId, scope }: { checkId: string; scope: 'device' | 'fleet' }) =>
      devicesApi.suppressSecurityCheck(checkId, scope === 'device' ? deviceId : null),
    onSuccess: invalidate,
  });
  const { data: suppressions = [] } = useQuery({
    queryKey: ['security-suppressions'],
    queryFn: () => devicesApi.listSecuritySuppressions().then(r => r.data),
  });
  const unsuppress = useMutation({
    mutationFn: (id: number) => devicesApi.unsuppressSecurityCheck(id),
    onSuccess: invalidate,
  });
  const suppressionFor = (checkId: string) =>
    suppressions.find(s => s.check_id === checkId && s.device_id === deviceId)
    ?? suppressions.find(s => s.check_id === checkId && s.device_id === null);

  // Editing a service's allowed addresses (#192). RouterOS 7.24 calls the
  // field available-from; older versions call it address.
  const [editingSvc, setEditingSvc] = useState<{ id: string; value: string[] } | null>(null);
  const allowedFromOf = (s: Row) => ((s['available-from'] ?? s.address ?? '') as string)
    .split(',').map(x => x.trim()).filter(Boolean);
  const setAllowed = useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, value, confirm = false }: { id: string; value: string; confirm?: boolean }) =>
      devicesApi.setServiceAllowedFrom(deviceId, id, value, confirm),
    onSuccess: () => { invalidate(); setLockout(null); setEditingSvc(null); setServiceError(''); },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => setAllowed.mutate({ ...vars, confirm: true }) });
        return;
      }
      const r = (err as { response?: { data?: { reason?: string; error?: string } } })?.response?.data;
      setServiceError(r?.reason || r?.error || 'Failed to update the allowed addresses');
    },
  });

  const toggleSvc = useMutation({
    mutationFn: ({ id, disabled, confirm = false }: { id: string; disabled: boolean; confirm?: boolean }) =>
      devicesApi.setServiceDisabled(deviceId, id, disabled, confirm),
    onSuccess: () => { invalidate(); setLockout(null); },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({
          verdict,
          retry: () => toggleSvc.mutate({ id: vars.id, disabled: vars.disabled, confirm: true }),
        });
        return;
      }
      // The management service has its own hard refusal (409 with a reason but no
      // verdict) — surface that text rather than a generic failure.
      const r = (err as { response?: { data?: { reason?: string; error?: string } } })?.response?.data;
      setServiceError(r?.reason || r?.error || 'Failed to update service');
    },
  });

  // Turn off plain API once the manager is on API-SSL (#201): checked first for
  // a working API-SSL login and for anything else still using plain API.
  const [plainApiNote, setPlainApiNote] = useState<{ ok: boolean; text: string } | null>(null);
  const plainApiOff = useMutation({
    mutationFn: (confirm: boolean) => devicesApi.disablePlainApi(deviceId, confirm),
    onSuccess: (res) => { setPlainApiNote({ ok: true, text: res.data.message }); setLockout(null); invalidate(); },
    onError: (err: unknown) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => plainApiOff.mutate(true) }); return; }
      const r = (err as { response?: { data?: { reason?: string; error?: string } } })?.response?.data;
      setPlainApiNote({ ok: false, text: r?.reason || r?.error || 'Could not turn plain API off' });
    },
  });

  // Switch management to API-SSL (outside review P1-4). The result lists what
  // was done on the device, and says plainly if the manager stayed on 8728.
  const [sslResult, setSslResult] = useState<ApiSslResult | null>(null);
  const [sslError, setSslError] = useState('');
  const apiSsl = useMutation({
    mutationFn: () => devicesApi.enableApiSsl(deviceId),
    onSuccess: (res) => {
      setSslResult(res.data);
      setSslError('');
      invalidate();
      qc.invalidateQueries({ queryKey: ['device', deviceId] });
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err: unknown) => {
      setSslResult(null);
      setSslError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not enable API-SSL');
    },
  });

  // WebFig over HTTPS (#234). Same result box as API-SSL: what was done, and
  // plainly when plain www was left on because HTTPS didn't answer.
  const wwwSsl = useMutation({
    mutationFn: () => devicesApi.enableWwwSsl(deviceId),
    onSuccess: (res) => { setSslResult(res.data); setSslError(''); invalidate(); },
    onError: (err: unknown) => {
      setSslResult(null);
      setSslError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not switch WebFig to HTTPS');
    },
  });

  const checks: SecurityCheck[] = posture?.checks ?? [];

  const activeCount = activeChecks(checks).length;

  const muted = mutedCount(checks);
  // No score when the audit couldn't run. It used to fall back to 100 (U5).
  const score = posture?.score ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-green-50 dark:bg-green-900/20 rounded-lg flex items-center justify-center"><ShieldCheck className="w-3.5 h-3.5 text-green-600 dark:text-green-400" /></div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Security Posture</h3>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5">
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Re-scan
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Auditing device…</div>
      ) : postureError || score === null ? (
        <div className="card"><LoadError what="this device's security audit" error={postureErr} /></div>
      ) : (
        <>
          {/* Score + summary */}
          <div className="card p-5 flex items-center gap-5">
            <div className="text-center">
              <div className={clsx('text-4xl font-bold', scoreColor(score))}>{score}</div>
              <div className="text-xs text-gray-400 uppercase tracking-wide" title="Heuristic hardening indicator, not an absolute grade">Hardening</div>
            </div>
            <div className="flex-1">
              {/* Counts exclude muted findings. Each muted row already says "not
                  counted"; this header counted them anyway, so the page
                  contradicted itself (#157). */}
              {activeCount === 0 ? (
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
                  <ShieldCheck className="w-4 h-4" />
                  {muted > 0
                    ? `No issues found — ${muted} muted finding${muted !== 1 ? 's' : ''} excluded.`
                    : 'No issues found — this device passes all baseline checks.'}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-gray-600 dark:text-slate-300 text-sm"><ShieldAlert className="w-4 h-4 text-amber-500" /> {activeCount} issue{activeCount !== 1 ? 's' : ''} found{muted > 0 ? `, ${muted} muted` : ''}. Review and remediate below.</div>
              )}
            </div>
          </div>

          {apiSsl.isPending && (
            <div className="p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-800 dark:text-blue-300 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Enabling API-SSL on the device. Creating a certificate can take up to a minute on small devices…
            </div>
          )}
          {wwwSsl.isPending && (
            <div className="p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Switching WebFig to HTTPS. Creating a certificate can take up to a minute on small devices…
            </div>
          )}
          {plainApiNote && (
            <div className={plainApiNote.ok
              ? 'p-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-400'
              : 'p-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-700 dark:text-amber-400'}>
              {plainApiNote.text}
            </div>
          )}
          {sslError && (
            <div className="p-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-400">{sslError}</div>
          )}
          {sslResult && (
            <div className={clsx('p-3 rounded-lg border text-sm',
              sslResult.switched
                ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300')}>
              <div className="flex items-start gap-2">
                {sslResult.switched ? <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                <div className="flex-1">
                  <p>{sslResult.message}</p>
                  {sslResult.steps.length > 0 && (
                    <ul className="mt-1.5 text-xs list-disc list-inside opacity-90">
                      {sslResult.steps.map((st, i) => <li key={i}>{st}</li>)}
                    </ul>
                  )}
                </div>
                <button onClick={() => setSslResult(null)} className="text-xs underline">Dismiss</button>
              </div>
            </div>
          )}

          {/* Findings */}
          {checks.length > 0 && (
            <div className="space-y-2">
              {checks.map(c => {
                const s = SEV_STYLE[c.severity] ?? SEV_STYLE.low;
                return (
                  <div key={c.id} className={clsx('border rounded-lg p-3 flex items-start gap-3',
                                                  c.suppressed ? 'border-gray-200 dark:border-slate-700 opacity-60' : s.ring)}>
                    <AlertTriangle className={clsx('w-4 h-4 flex-shrink-0 mt-0.5', c.suppressed ? 'text-gray-400' : s.text)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900 dark:text-white">{c.title}</span>
                        <span className={clsx('text-[10px] font-bold uppercase px-1.5 py-0.5 rounded',
                                              c.suppressed ? 'text-gray-400' : s.text)}>{s.label}</span>
                        {c.suppressed && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                            muted {c.suppressed_scope === 'fleet' ? 'fleet-wide' : 'on this device'} · not counted
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 dark:text-slate-400 mt-0.5">{c.detail}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {canWrite && c.fix === 'api-ssl' && !c.suppressed && (
                        <button onClick={() => apiSsl.mutate()} disabled={apiSsl.isPending}
                          className="btn-primary text-xs py-1 flex items-center gap-1.5">
                          {apiSsl.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
                          {apiSsl.isPending ? 'Switching…' : 'Switch to API-SSL'}
                        </button>
                      )}
                      {canWrite && c.fix === 'www-ssl' && !c.suppressed && (
                        <button onClick={() => wwwSsl.mutate()} disabled={wwwSsl.isPending}
                          title="Enable www-ssl with a certificate, then turn plain www off once HTTPS answers"
                          className="btn-primary text-xs py-1 flex items-center gap-1.5">
                          {wwwSsl.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Globe className="w-3 h-3" />}
                          {wwwSsl.isPending ? 'Switching…' : 'Switch to HTTPS'}
                        </button>
                      )}
                      {canWrite && c.fix === 'api-off' && !c.suppressed && (
                        <button onClick={() => { setPlainApiNote(null); plainApiOff.mutate(false); }} disabled={plainApiOff.isPending}
                          title="Checks the manager can log in over API-SSL and that nothing else uses plain API, then turns it off"
                          className="btn-primary text-xs py-1 flex items-center gap-1.5">
                          {plainApiOff.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />}
                          {plainApiOff.isPending ? 'Checking…' : 'Turn off plain API'}
                        </button>
                      )}
                      {canWrite && c.serviceId && c.fix !== 'api-off' && !c.suppressed && (
                        <button onClick={() => toggleSvc.mutate({ id: c.serviceId!, disabled: true })} disabled={toggleSvc.isPending}
                          className="btn-secondary text-xs py-1 flex items-center gap-1.5"><Lock className="w-3 h-3" /> Disable</button>
                      )}
                      {canWrite && (c.suppressed ? (
                        <button
                          onClick={() => { const hit = suppressionFor(c.id); if (hit) unsuppress.mutate(hit.id); }}
                          disabled={unsuppress.isPending}
                          title="Count this check again"
                          className="btn-secondary text-xs py-1 flex items-center gap-1.5"><Bell className="w-3 h-3" /> Unmute</button>
                      ) : (
                        <>
                          <button onClick={() => suppress.mutate({ checkId: c.id, scope: 'device' })} disabled={suppress.isPending}
                            title="Stop counting this check on this device"
                            className="btn-secondary text-xs py-1 flex items-center gap-1.5"><BellOff className="w-3 h-3" /> Mute</button>
                          <button onClick={() => suppress.mutate({ checkId: c.id, scope: 'fleet' })} disabled={suppress.isPending}
                            title="Stop counting this check on every device"
                            className="btn-secondary text-xs py-1">Fleet</button>
                        </>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* IP services table */}
          <div className="card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-200">Management Services</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                  <th className="table-header px-3 py-2 text-left">Service</th>
                  <th className="table-header px-3 py-2 text-left">Port</th>
                  <th className="table-header px-3 py-2 text-left">Allowed From</th>
                  <th className="table-header px-3 py-2 text-left">Status</th>
                  {canWrite && <th className="table-header px-3 py-2 w-24" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {services.map((s, i) => {
                  const enabled = s.disabled !== 'true';
                  const insecure = ['telnet', 'ftp', 'www'].includes(s.name ?? '') || (s.name === 'api' && mgmtService !== 'api');
                  const isMgmt = s.name === mgmtService;
                  return (
                    <tr key={s['.id'] ?? i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                      <td className={clsx('px-3 py-2 text-xs font-medium', enabled && insecure ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white')}>
                        {s.name}{isMgmt && <span className="ml-1.5 text-[10px] font-normal text-blue-500" title="MikroTik Manager connects through this service">(managed via)</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">{s.port || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">
                        {editingSvc?.id === s['.id'] ? (
                          <form className="flex items-center gap-1.5"
                            onSubmit={(e) => { e.preventDefault(); setAllowed.mutate({ id: s['.id'], value: editingSvc.value.join(',') }); }}>
                            <div className="w-72">
                              <ListInput value={editingSvc.value} ariaLabel="Allowed addresses"
                                onChange={(next) => setEditingSvc({ id: s['.id'], value: next })}
                                validate={(e) => (isIpOrPrefix(e) ? null : `${e} isn't an IP address or prefix`)}
                                placeholder="empty = any address" />
                            </div>
                            <button type="submit" disabled={setAllowed.isPending} className="btn-primary text-xs px-2 py-1">Save</button>
                            <button type="button" onClick={() => setEditingSvc(null)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-slate-300">Cancel</button>
                          </form>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            {allowedFromOf(s).join(', ') || 'any'}
                            {canWrite && (
                              <button type="button" title="Change which addresses may connect"
                                onClick={() => { setServiceError(''); setEditingSvc({ id: s['.id'], value: allowedFromOf(s) }); }}
                                className="text-blue-600 dark:text-blue-400 hover:underline font-sans">edit</button>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                          enabled ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400')}>
                          <span className={clsx('w-1.5 h-1.5 rounded-full', enabled ? 'bg-green-500' : 'bg-gray-400')} />
                          {enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                      {canWrite && (
                        <td className="px-3 py-2 text-right">
                          {isMgmt ? (
                            <span className="text-[11px] text-gray-400 flex items-center gap-1 justify-end" title="Disabling this would cut MikroTik Manager off from the device">
                              <Lock className="w-3 h-3" /> in use
                            </span>
                          ) : (
                            <button onClick={() => toggleSvc.mutate({ id: s['.id'], disabled: enabled })} disabled={toggleSvc.isPending}
                              className={clsx('text-xs font-medium flex items-center gap-1 ml-auto px-2 py-1 rounded border transition-colors disabled:opacity-50',
                                enabled
                                  ? 'border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20'
                                  : 'border-green-300 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/20')}>
                              {enabled ? <><Lock className="w-3 h-3" />Disable</> : <><Check className="w-3 h-3" />Enable</>}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {serviceError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
          {serviceError}
        </div>
      )}

      {lockout && (
        <LockoutVerdictDialog
          deviceId={deviceId}
          verdict={lockout.verdict}
          confirmPhrase={deviceName || 'confirm'}
          pending={toggleSvc.isPending}
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}
    </div>
  );
}
