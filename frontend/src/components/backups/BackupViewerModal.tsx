import { useQuery } from '@tanstack/react-query';
import { X, FileText, GitCompare, Download, Loader2, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';
import { backupsApi } from '../../services/api';
import { lineDiff } from '../../utils/lineDiff';

/**
 * Reads a backup in place, or compares two (#134).
 *
 * Backups are `/export compact` output — plain RouterOS script, not the binary
 * `.backup` blob — so both are just text. The diff reuses the same lineDiff
 * that Config History already uses, rather than introducing a second one.
 */
interface Props {
  /** One id previews; two compare, oldest first. */
  ids: number[];
  onClose: () => void;
  onDownload: (id: number, filename: string) => void;
}

function errorText(e: unknown): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string };
  return err.response?.data?.error ?? err.message ?? 'Could not read this backup.';
}

export default function BackupViewerModal({ ids, onClose, onDownload }: Props) {
  const comparing = ids.length === 2;

  const single = useQuery({
    queryKey: ['backup-content', ids[0]],
    queryFn: () => backupsApi.content(ids[0]).then((r) => r.data),
    enabled: !comparing && ids.length === 1,
    retry: false,
  });

  const pair = useQuery({
    queryKey: ['backup-diff', ids[0], ids[1]],
    queryFn: () => backupsApi.diff(ids[0], ids[1]).then((r) => r.data),
    enabled: comparing,
    retry: false,
  });

  const loading = comparing ? pair.isLoading : single.isLoading;
  const error = comparing ? pair.error : single.error;

  const rows = pair.data ? lineDiff(pair.data.from.text, pair.data.to.text) : [];
  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-4 border-b border-gray-200 dark:border-slate-700">
          {comparing
            ? <GitCompare className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
            : <FileText className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />}
          <div className="min-w-0 flex-1">
            {comparing ? (
              <>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                  Comparing backups
                </h3>
                {pair.data && (
                  // The filename lives here rather than in the table: it is how you
                  // would refer to this file to someone else, so it belongs where
                  // you are actually looking at the file.
                  <p className="text-xs font-mono text-gray-500 dark:text-slate-400 break-all mt-0.5">
                    {pair.data.from.filename} → {pair.data.to.filename}
                  </p>
                )}
              </>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                  {single.data?.device_name ?? 'Backup'}
                </h3>
                {single.data && (
                  <p className="text-xs font-mono text-gray-500 dark:text-slate-400 break-all mt-0.5">
                    {single.data.filename}
                  </p>
                )}
              </>
            )}
            {!comparing && single.data && (
              <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                {format(new Date(single.data.created_at), 'MMM d, yyyy HH:mm')}
                {single.data.notes ? ` · ${single.data.notes}` : ''}
              </p>
            )}
            {comparing && pair.data && (
              <p className="text-xs mt-0.5">
                <span className="text-green-600 dark:text-green-400">+{added}</span>{' '}
                <span className="text-red-600 dark:text-red-400">−{removed}</span>
                <span className="text-gray-400 dark:text-slate-500">
                  {' '}· {format(new Date(pair.data.from.created_at), 'MMM d HH:mm')}
                  {' → '}{format(new Date(pair.data.to.created_at), 'MMM d HH:mm')}
                </span>
              </p>
            )}
          </div>
          {!comparing && single.data && (
            <button
              onClick={() => onDownload(single.data!.id, single.data!.filename)}
              className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20"
              title="Download"
            >
              <Download className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Reading…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-600 dark:text-red-400">{errorText(error)}</p>
            </div>
          )}

          {!loading && !error && comparing && (
            added + removed === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">
                These two backups are identical.
              </p>
            ) : (
              <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700 rounded-lg p-3 leading-relaxed">
                {rows.map((row, i) => (
                  <div
                    key={i}
                    className={clsx(
                      'whitespace-pre-wrap',
                      row.type === 'add' && 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400',
                      row.type === 'del' && 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400',
                      row.type === 'ctx' && 'text-gray-500 dark:text-slate-400'
                    )}
                  >
                    {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '} {row.text}
                  </div>
                ))}
              </pre>
            )
          )}

          {!loading && !error && !comparing && single.data && (
            <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700 rounded-lg p-3 leading-relaxed whitespace-pre-wrap">
              {single.data.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
