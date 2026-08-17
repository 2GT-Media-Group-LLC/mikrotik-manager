import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, RefreshCw, Check, AlertTriangle, Lock } from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { SecurityCheck } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';
import clsx from 'clsx';

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

  const { data: posture, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['security-posture', deviceId],
    queryFn: () => devicesApi.getSecurityPosture(deviceId).then(r => r.data),
  });
  const { data: servicesRaw = [] } = useQuery({
    queryKey: ['services', deviceId],
    queryFn: () => devicesApi.getServices(deviceId).then(r => r.data as Row[]),
  });
  // Some devices report duplicate /ip/service rows (e.g. api twice) — show one per name.
  const services = Array.from(new Map(servicesRaw.map(s => [s.name ?? s['.id'], s])).values());
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
  };
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

  const checks: SecurityCheck[] = posture?.checks ?? [];
  const score = posture?.score ?? 100;

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
      ) : (
        <>
          {/* Score + summary */}
          <div className="card p-5 flex items-center gap-5">
            <div className="text-center">
              <div className={clsx('text-4xl font-bold', scoreColor(score))}>{score}</div>
              <div className="text-xs text-gray-400 uppercase tracking-wide" title="Heuristic hardening indicator, not an absolute grade">Hardening</div>
            </div>
            <div className="flex-1">
              {checks.length === 0 ? (
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium"><ShieldCheck className="w-4 h-4" /> No issues found — this device passes all baseline checks.</div>
              ) : (
                <div className="flex items-center gap-2 text-gray-600 dark:text-slate-300 text-sm"><ShieldAlert className="w-4 h-4 text-amber-500" /> {checks.length} issue{checks.length !== 1 ? 's' : ''} found. Review and remediate below.</div>
              )}
            </div>
          </div>

          {/* Findings */}
          {checks.length > 0 && (
            <div className="space-y-2">
              {checks.map(c => {
                const s = SEV_STYLE[c.severity] ?? SEV_STYLE.low;
                return (
                  <div key={c.id} className={clsx('border rounded-lg p-3 flex items-start gap-3', s.ring)}>
                    <AlertTriangle className={clsx('w-4 h-4 flex-shrink-0 mt-0.5', s.text)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900 dark:text-white">{c.title}</span>
                        <span className={clsx('text-[10px] font-bold uppercase px-1.5 py-0.5 rounded', s.text)}>{s.label}</span>
                      </div>
                      <p className="text-xs text-gray-600 dark:text-slate-400 mt-0.5">{c.detail}</p>
                    </div>
                    {canWrite && c.serviceId && (
                      <button onClick={() => toggleSvc.mutate({ id: c.serviceId!, disabled: true })} disabled={toggleSvc.isPending}
                        className="btn-secondary text-xs py-1 flex items-center gap-1.5 flex-shrink-0"><Lock className="w-3 h-3" /> Disable</button>
                    )}
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
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">{s.address || 'any'}</td>
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
                              className="text-xs text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1 ml-auto">
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
