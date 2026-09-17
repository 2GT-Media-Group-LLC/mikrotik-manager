import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Shield, ShieldCheck, ShieldAlert, RefreshCw, ChevronDown, ChevronRight,
  Gauge, Server, AlertTriangle, ListChecks, KeyRound,
} from 'lucide-react';
import { devicesApi, certificatesApi } from '../services/api';
import type { SecurityCheck } from '../services/api';
import type { Device } from '../types';
import clsx from 'clsx';
import CertificateList from '../components/CertificateList';

interface DevicePosture {
  id: number; name: string; ip_address: string; device_type?: string;
  score: number | null; checks: SecurityCheck[]; error?: string;
}

function scoreColor(score: number | null) {
  if (score === null) return 'text-gray-400';
  if (score >= 85) return 'text-green-600 dark:text-green-400';
  if (score >= 60) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

const SEV_BADGE: Record<string, string> = {
  high: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  medium: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  low: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
};
const SEV_DOT: Record<string, string> = { high: 'bg-red-500', medium: 'bg-amber-500', low: 'bg-blue-500' };
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, ok: 3 };

function Kpi({ icon: Icon, label, value, accent, valueClass }: {
  icon: React.ElementType; label: string; value: React.ReactNode; accent: string; valueClass?: string;
}) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0', accent)}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-gray-400 dark:text-slate-500 truncate">{label}</div>
        <div className={clsx('text-2xl font-bold leading-tight', valueClass ?? 'text-gray-900 dark:text-white')}>{value}</div>
      </div>
    </div>
  );
}

export default function SecurityPage() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: certData, isLoading: certLoading } = useQuery({
    queryKey: ['fleet-certificates'],
    queryFn: () => certificatesApi.list().then((r) => r.data),
    staleTime: 60_000,
  });
  const badCount = (certData?.certificates ?? []).filter(
    (c) => c.state === 'expired' || c.state === 'expiring' || c.state === 'not-yet-valid'
  ).length;

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });
  const online = (devices as Device[]).filter(d => d.status === 'online');
  const onlineKey = online.map(d => d.id).join(',');

  const { data: fleet = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['security-fleet', onlineKey],
    queryFn: async (): Promise<DevicePosture[]> => {
      const results = await Promise.allSettled(
        online.map(async (d) => {
          const r = await devicesApi.getSecurityPosture(d.id);
          return { id: d.id, name: d.name, ip_address: d.ip_address, device_type: d.device_type, score: r.data.score, checks: r.data.checks };
        })
      );
      return results.map((r, i) =>
        r.status === 'fulfilled' ? r.value
          : { id: online[i].id, name: online[i].name, ip_address: online[i].ip_address, device_type: online[i].device_type, score: null, checks: [], error: (r.reason as Error)?.message });
    },
    enabled: online.length > 0,
    refetchInterval: 120_000,
  });

  const scored = fleet.filter(f => f.score !== null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, f) => s + (f.score ?? 0), 0) / scored.length) : null;
  const totalFindings = fleet.reduce((s, f) => s + f.checks.length, 0);
  const highCount = fleet.reduce((s, f) => s + f.checks.filter(c => c.severity === 'high').length, 0);

  // Aggregate identical findings across the fleet ("telnet enabled — 3 devices").
  const commonFindings = (() => {
    const m = new Map<string, { title: string; severity: string; count: number }>();
    for (const f of fleet) for (const c of f.checks) {
      const e = m.get(c.title) ?? { title: c.title, severity: c.severity, count: 0 };
      e.count++; m.set(c.title, e);
    }
    return [...m.values()].sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || (b.count - a.count));
  })();

  const goManage = (id: number) => navigate(`/devices/${id}?tab=security`);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Shield className="w-5 h-5 text-blue-500" /> Security</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Fleet-wide firewall posture and access control</p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors">
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Re-scan fleet
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={Gauge} label="Avg hardening score" accent="bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
          value={avgScore ?? '—'} valueClass={scoreColor(avgScore)} />
        <Kpi icon={Server} label="Devices scanned" accent="bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400"
          value={<>{scored.length}<span className="text-sm font-normal text-gray-400">/{online.length}</span></>} />
        <Kpi icon={ShieldAlert} label="Total findings" accent="bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
          value={totalFindings} />
        <Kpi icon={AlertTriangle} label="High severity" accent={highCount > 0 ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'}
          value={highCount} valueClass={highCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'} />
      </div>

      {/* Main: posture list (wide) + common findings (narrow) */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        {/* Fleet posture */}
        <div className="card overflow-hidden xl:col-span-2">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-green-500" />
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Fleet Security Posture</h2>
          </div>
          {isLoading ? (
            <div className="p-8 text-center text-sm text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Auditing devices…</div>
          ) : online.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">No online devices to scan.</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-700">
              {fleet.map(f => {
                const open = expanded === f.id;
                const highs = f.checks.filter(c => c.severity === 'high').length;
                const meds = f.checks.filter(c => c.severity === 'medium').length;
                const lows = f.checks.filter(c => c.severity === 'low').length;
                return (
                  <div key={f.id}>
                    <div className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 dark:hover:bg-slate-700/30">
                      <button onClick={() => setExpanded(open ? null : f.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                        {f.checks.length > 0 ? (open ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />) : <span className="w-4 flex-shrink-0" />}
                        <div className={clsx('text-xl font-bold w-10 text-center flex-shrink-0', scoreColor(f.score))}>{f.score ?? '—'}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{f.name}</div>
                          <div className="text-xs text-gray-400 font-mono">{f.ip_address}</div>
                        </div>
                        {f.error ? <span className="text-xs text-red-500">{f.error}</span> : f.checks.length === 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><ShieldCheck className="w-3.5 h-3.5" /> Clean</span>
                        ) : (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {highs > 0 && <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium', SEV_BADGE.high)}>{highs} high</span>}
                            {meds > 0 && <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium', SEV_BADGE.medium)}>{meds} med</span>}
                            {lows > 0 && <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium', SEV_BADGE.low)}>{lows} low</span>}
                          </div>
                        )}
                      </button>
                      <button onClick={() => goManage(f.id)} className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline flex-shrink-0 ml-1">Manage →</button>
                    </div>
                    {open && f.checks.length > 0 && (
                      <div className="px-5 pb-3 pl-16 space-y-1.5">
                        {f.checks.map(c => (
                          <div key={c.id} className="flex items-start gap-2 text-xs">
                            <ShieldAlert className={clsx('w-3.5 h-3.5 flex-shrink-0 mt-0.5', c.severity === 'high' ? 'text-red-500' : c.severity === 'medium' ? 'text-amber-500' : 'text-blue-500')} />
                            <div><span className="font-medium text-gray-800 dark:text-slate-200">{c.title}</span> <span className="text-gray-500 dark:text-slate-400">— {c.detail}</span></div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Certificates across the fleet (#143) */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2 flex-wrap">
            <KeyRound className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Certificates</h2>
            {certData && (
              <span className="text-xs text-gray-400 dark:text-slate-500">
                {certData.certificates.length} across the fleet
                {certData.alertingEnabled
                  ? ` · alerting ${certData.warnDays} days ahead`
                  : ' · expiry alerting is off'}
              </span>
            )}
            {/* Counted, not just listed: "two expiring" is the number worth seeing
                without reading every row. */}
            {certData && (badCount > 0) && (
              <span className="ml-auto text-xs font-medium text-amber-600 dark:text-amber-400">
                {badCount} need attention
              </span>
            )}
          </div>
          <div className="p-2">
            {certLoading
              ? <p className="p-6 text-center text-sm text-gray-400">Loading…</p>
              : <CertificateList
                  certificates={certData?.certificates ?? []}
                  showDevice
                  emptyText="No certificates collected yet — they are read on each slow poll."
                />}
          </div>
        </div>

        {/* Common findings across the fleet */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Common Findings</h2>
          </div>
          {commonFindings.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">
              {isLoading ? 'Scanning…' : <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400"><ShieldCheck className="w-4 h-4" /> No issues across the fleet</span>}
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-700">
              {commonFindings.map(c => (
                <div key={c.title} className="flex items-center gap-3 px-5 py-2.5">
                  <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', SEV_DOT[c.severity])} />
                  <span className="text-sm text-gray-700 dark:text-slate-300 flex-1 min-w-0 truncate" title={c.title}>{c.title}</span>
                  <span className="text-xs text-gray-400 dark:text-slate-500 flex-shrink-0">{c.count} {c.count === 1 ? 'device' : 'devices'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
