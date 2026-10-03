import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { format, formatDistanceToNow } from 'date-fns';
import { firmwareApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import RolloutPanel from '../components/firmware/RolloutPanel';
import { ROLLOUT_STATUS } from '../components/firmware/rolloutStatus';
import LoadError from '../components/common/LoadError';

const PAGE = 25;

/** Every firmware rollout, a page at a time (#202). */
export default function FirmwareHistoryPage() {
  const canWrite = useCanWrite();
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['fw-rollouts-page', page],
    queryFn: () => firmwareApi.listRolloutsPage(PAGE, page * PAGE),
    placeholderData: keepPreviousData,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/firmware" className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Firmware
        </Link>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Upgrade history</h1>
        <span className="text-sm text-gray-400 dark:text-slate-500">{total} rollout{total === 1 ? '' : 's'}</span>
      </div>

      {isError ? <LoadError what="rollout history" error={error} /> : (
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">No rollouts yet.</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-700/50">
              {rows.map((r) => (
                <div key={r.id}>
                  <button onClick={() => setOpenId(openId === r.id ? null : r.id)}
                    className="w-full px-5 py-2.5 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-slate-700/40 transition-colors">
                    <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium capitalize flex-shrink-0', ROLLOUT_STATUS[r.status])}>{r.status}</span>
                    <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{r.name}</span>
                    <span className="text-xs text-gray-400 dark:text-slate-500">
                      {r.success_count}/{r.device_count} succeeded{(r.failed_count ?? 0) > 0 ? ` · ${r.failed_count} failed` : ''}
                    </span>
                    <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500 flex-shrink-0"
                      title={format(new Date(r.created_at), 'PPpp')}>
                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </span>
                  </button>
                  {openId === r.id && (
                    <div className="px-3 pb-3"><RolloutPanel rolloutId={r.id} canWrite={canWrite} /></div>
                  )}
                </div>
              ))}
            </div>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between px-5 py-2.5 border-t border-gray-200 dark:border-slate-700 text-xs text-gray-500 dark:text-slate-400">
              <span>Page {page + 1} of {pages}</span>
              <div className="flex items-center gap-1">
                <button className="p-1 rounded disabled:opacity-40" disabled={page === 0}
                  onClick={() => { setOpenId(null); setPage((p) => p - 1); }} aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
                <button className="p-1 rounded disabled:opacity-40" disabled={page + 1 >= pages}
                  onClick={() => { setOpenId(null); setPage((p) => p + 1); }} aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
