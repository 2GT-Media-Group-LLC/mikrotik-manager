import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { devicesApi, type ApiSslResult } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import type { Device } from '../../types';
import clsx from 'clsx';

const API_SSL_PORT = 8729;

type Outcome = { state: 'working' } | { state: 'done'; result: ApiSslResult } | { state: 'error'; message: string };

/**
 * Devices the manager still reaches over the plain API, which sends each
 * device's login in the clear on every poll (outside review P1-4). Each can be
 * moved to API-SSL here; the manager enables it on the device and switches only
 * once it has logged in over it.
 */
export default function ApiSslCard() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [runningAll, setRunningAll] = useState(false);

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
    staleTime: 60_000,
  });
  const all = devices as Device[];
  const plain = all.filter((d) => d.api_port !== API_SSL_PORT);

  const switchOne = async (d: Device): Promise<void> => {
    setOutcomes((o) => ({ ...o, [d.id]: { state: 'working' } }));
    try {
      const res = await devicesApi.enableApiSsl(d.id);
      setOutcomes((o) => ({ ...o, [d.id]: { state: 'done', result: res.data } }));
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not enable API-SSL';
      setOutcomes((o) => ({ ...o, [d.id]: { state: 'error', message } }));
    }
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['devices'] });
    void qc.invalidateQueries({ queryKey: ['security-fleet'] });
  };

  // One device at a time: each creates a certificate on its device, and doing
  // them all at once would only make the slow ones slower.
  const switchAll = async () => {
    setRunningAll(true);
    for (const d of plain.filter((x) => x.status === 'online')) {
      const prior = outcomes[d.id];
      if (prior?.state === 'done' && prior.result.switched) continue;
      await switchOne(d);
    }
    setRunningAll(false);
    refresh();
  };

  // Devices switched in this visit stay listed with their outcome until the
  // list refreshes, so the result can be read.
  const shown = all.filter((d) => d.api_port !== API_SSL_PORT || outcomes[d.id]);
  const [expanded, setExpanded] = useState(false);

  // Only a prompt to act: nothing is shown while every device is on API-SSL.
  if (shown.length === 0) return null;

  const PREVIEW = 5;
  const visible = expanded ? shown : shown.slice(0, PREVIEW);

  return (
    <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 overflow-hidden">
      <div className="flex items-start justify-between gap-3 flex-wrap px-4 py-3">
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div>
            <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              {plain.length > 0
                ? `${plain.length} device${plain.length === 1 ? ' is' : 's are'} managed over the unencrypted API`
                : 'All devices are now managed over API-SSL'}
            </h2>
            {plain.length > 0 && (
              <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                The plain API (8728) sends each device&apos;s login in the clear on every poll. Switching enables
                API-SSL on the device (with a self-signed certificate if it has none) and moves the manager over only
                once it has logged in over it. The plain API stays on until you turn it off.
              </p>
            )}
          </div>
        </div>
        {canWrite && plain.some((d) => d.status === 'online') && (
          <button onClick={() => { void switchAll(); }} disabled={runningAll}
            className="btn-primary text-xs py-1.5 flex items-center gap-1.5 flex-shrink-0">
            {runningAll ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            {runningAll ? 'Switching…' : plain.filter((d) => d.status === 'online').length > 1 ? 'Switch all online' : 'Switch to API-SSL'}
          </button>
        )}
      </div>

      <ul className="divide-y divide-amber-200/70 dark:divide-amber-800/50 border-t border-amber-200 dark:border-amber-800 bg-white/60 dark:bg-slate-900/30">
        {visible.map((d) => {
          const o = outcomes[d.id];
          return (
            <li key={d.id} className="px-4 py-2.5 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-white">{d.name}</div>
                <div className="text-xs text-gray-500 dark:text-slate-400">
                  {d.ip_address} · port {d.api_port}{d.status !== 'online' ? ` · ${d.status}` : ''}
                </div>
                {o?.state === 'done' && (
                  <p className={clsx('text-xs mt-1 flex items-start gap-1',
                    o.result.switched ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400')}>
                    {o.result.switched ? <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}
                    {o.result.message}
                  </p>
                )}
                {o?.state === 'error' && <p className="text-xs mt-1 text-red-600 dark:text-red-400">{o.message}</p>}
              </div>
              {canWrite && !(o?.state === 'done' && o.result.switched) && (
                <button onClick={() => { void switchOne(d).then(refresh); }}
                  disabled={runningAll || o?.state === 'working' || d.status !== 'online'}
                  title={d.status !== 'online' ? 'The device must be online' : undefined}
                  className="btn-secondary text-xs py-1 flex items-center gap-1.5 flex-shrink-0">
                  {o?.state === 'working' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
                  {o?.state === 'working' ? 'Switching…' : 'Switch to API-SSL'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {shown.length > PREVIEW && (
        <button onClick={() => setExpanded((e) => !e)}
          className="w-full px-4 py-2 text-xs font-medium text-amber-800 dark:text-amber-300 border-t border-amber-200 dark:border-amber-800 hover:bg-amber-100/60 dark:hover:bg-amber-900/30">
          {expanded ? 'Show fewer' : `Show all ${shown.length}`}
        </button>
      )}
    </div>
  );
}
