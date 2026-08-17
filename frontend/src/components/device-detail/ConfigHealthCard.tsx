import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, ChevronDown, ChevronRight, CircleCheck,
  ExternalLink, RefreshCw, ShieldAlert, Wrench,
} from 'lucide-react';
import { devicesApi, type ConfigFinding } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import clsx from 'clsx';

const SEV: Record<ConfigFinding['severity'], { chip: string; card: string; label: string }> = {
  critical: {
    chip: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
    card: 'border-red-300 dark:border-red-800',
    label: 'Broken',
  },
  warning: {
    chip: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
    card: 'border-amber-300 dark:border-amber-800',
    label: 'Fragile',
  },
  info: {
    chip: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
    card: 'border-blue-300 dark:border-blue-800',
    label: 'Note',
  },
};

function since(iso: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'first seen today';
  if (days === 1) return 'present for 1 day';
  return `present for ${days} days`;
}

function Finding({ f }: { f: ConfigFinding }) {
  const [open, setOpen] = useState(f.severity === 'critical');
  const style = SEV[f.severity];

  return (
    <div className={clsx('rounded-lg border', style.card)}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start gap-2.5 p-3 text-left"
      >
        {open
          ? <ChevronDown className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
          : <ChevronRight className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded', style.chip)}>
              {style.label}
            </span>
            <span className="text-sm font-medium text-gray-900 dark:text-white">{f.title}</span>
          </div>
          {!open && f.first_seen && (
            <div className="mt-0.5 text-xs text-gray-400">{since(f.first_seen)}</div>
          )}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pl-9 space-y-2.5">
          <p className="text-sm text-gray-600 dark:text-slate-300">{f.detail}</p>

          {f.remediation && (
            <div className="flex items-start gap-2 rounded-md bg-gray-50 dark:bg-slate-800/60 p-2.5">
              <Wrench className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-400" />
              <p className="text-sm text-gray-700 dark:text-slate-200">{f.remediation}</p>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap text-xs text-gray-400">
            {f.objects.length > 0 && (
              <span className="mono">{f.objects.join(' · ')}</span>
            )}
            {f.first_seen && <span>{since(f.first_seen)}</span>}
            {f.doc_url && (
              <a
                href={f.doc_url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
              >
                MikroTik docs <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Standing audit for configurations RouterOS accepted but that do not work.
 *
 * Distinct from the hardening score above it: nothing here is a security setting.
 * These are contradictions the device will never report — an address on a slave
 * port, a PVID that a frame-type makes inert — so this panel is the only place
 * they become visible.
 */
export default function ConfigHealthCard({ deviceId }: { deviceId: number }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [scanError, setScanError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['config-health', deviceId],
    queryFn: () => devicesApi.getConfigHealth(deviceId).then((r) => r.data),
  });

  const scan = useMutation({
    mutationFn: () => devicesApi.scanConfigHealth(deviceId).then((r) => r.data),
    onSuccess: (fresh) => {
      qc.setQueryData(['config-health', deviceId], fresh);
      setScanError('');
    },
    onError: (err: unknown) => {
      const r = (err as { response?: { data?: { error?: string } } })?.response?.data;
      setScanError(r?.error || 'Could not audit the device');
    },
  });

  const findings = data?.findings ?? [];
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center">
            <Activity className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Config Health</h3>
          {critical > 0 && (
            <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded', SEV.critical.chip)}>
              {critical} broken
            </span>
          )}
          {warnings > 0 && (
            <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded', SEV.warning.chip)}>
              {warnings} fragile
            </span>
          )}
        </div>
        {canWrite && (
          <button
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
            className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', scan.isPending && 'animate-spin')} /> Re-audit
          </button>
        )}
      </div>

      <p className="text-xs text-gray-500 dark:text-slate-400">
        RouterOS applies each command on its own, with no check that the result is coherent — so a
        configuration can be accepted, saved, and still not work. This audit looks for those cases.
      </p>

      {scanError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-500" />
          <p className="text-sm text-red-800 dark:text-red-300">{scanError}</p>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-6 text-gray-400 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading findings…
        </div>
      ) : findings.length === 0 ? (
        <div className="card p-4 flex items-start gap-2.5">
          <CircleCheck className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-600 dark:text-green-400" />
          <div>
            <div className="text-sm font-medium text-green-700 dark:text-green-400">
              No configuration conflicts found
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {data?.checked_at
                ? `Last audited ${new Date(data.checked_at).toLocaleString()}.`
                : 'This device has not been audited yet — run one with Re-audit.'}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {findings.map((f) => <Finding key={`${f.rule}:${f.objects.join(',')}`} f={f} />)}
          </div>
          {data?.checked_at && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <ShieldAlert className="w-3 h-3" />
              Last audited {new Date(data.checked_at).toLocaleString()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
