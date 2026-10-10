import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TerminalSquare, RefreshCw, CheckCircle } from 'lucide-react';
import { devicesApi } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import type { Device } from '../../types';

/**
 * A device added over SSH only (#174): what works now, what waits for the API,
 * and a button to check the API without waiting for the poller (which tries
 * every minute, and every 15 after a refused login).
 */
export default function SshOnlyBanner({ device }: { device: Device }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const check = useMutation({
    mutationFn: () => devicesApi.checkApi(device.id).then((r) => r.data),
    onSuccess: (d) => {
      setResult(d.api ? { ok: true, text: d.message ?? 'The API answers.' } : { ok: false, text: d.reason ?? 'The API still doesn’t answer.' });
      void qc.invalidateQueries({ queryKey: ['device', device.id] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e: unknown) => setResult({ ok: false, text: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'The check failed.' }),
  });

  const checked = device.api_checked_at ? new Date(device.api_checked_at) : null;
  const lastReason = result ? null : device.api_check_error;

  return (
    <div className="card p-4 border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/10 space-y-2">
      <div className="flex items-start gap-3">
        <TerminalSquare className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-1.5 text-sm">
          <p className="font-medium text-gray-900 dark:text-white">Added over SSH only: the RouterOS API isn&apos;t enabled yet</p>
          <p className="text-gray-600 dark:text-slate-300">
            Bulk commands, templates, the terminal, backups and config history work now. Live status, graphs, clients,
            ports, VLANs and the other tabs need the API. Turn on api-ssl (for example a bulk command run without Change
            Guard: <code className="mono text-xs">/ip service enable api-ssl</code>) and the manager switches over by itself,
            usually within a minute.
          </p>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            The API is tried with the login <span className="mono">{device.api_username}</span>; change it in Edit Device if the API uses another one.
            {checked && <> Last checked {checked.toLocaleString()}{lastReason ? `: ${lastReason}` : '.'}</>}
          </p>
          {result && (
            <p className={result.ok ? 'flex items-center gap-1.5 text-green-700 dark:text-green-400' : 'text-amber-800 dark:text-amber-300'}>
              {result.ok && <CheckCircle className="w-4 h-4" />}{result.text}
            </p>
          )}
        </div>
        {canWrite && (
          <button className="btn-secondary text-sm flex items-center gap-1.5 flex-shrink-0" disabled={check.isPending}
            onClick={() => { setResult(null); check.mutate(); }}>
            <RefreshCw className={check.isPending ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'} />
            {check.isPending ? 'Checking…' : 'Check API'}
          </button>
        )}
      </div>
    </div>
  );
}
