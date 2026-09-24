import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Upload, Download, Loader2, Check, AlertTriangle, FileText } from 'lucide-react';
import clsx from 'clsx';
import { credentialPresetsApi, devicesApi, type BulkAddJobStatus } from '../../services/api';
import { parseDeviceCsv, CSV_TEMPLATE, MAX_ROWS } from '../../utils/csvImport';

/**
 * Bulk device import from a CSV file (#160).
 *
 * Valid rows are handed to the same background job as "Try All", so the import
 * keeps running if this dialog or the browser tab is closed.
 */

interface Props {
  existingAddresses: string[];
  onClose: () => void;
  onSuccess: () => void;
}

type Result = NonNullable<BulkAddJobStatus['results']>[number];

export default function CsvImportModal({ existingAddresses, onClose, onSuccess }: Props) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: presets = [] } = useQuery({
    queryKey: ['credential-presets'],
    queryFn: () => credentialPresetsApi.list().then((r) => r.data),
  });

  const parsed = useMemo(
    () => (text.trim() ? parseDeviceCsv(text, presets, existingAddresses) : null),
    [text, presets, existingAddresses]
  );
  const ready = parsed?.rows.filter((r) => r.item && !r.skip) ?? [];
  const skipped = parsed?.rows.filter((r) => r.skip) ?? [];
  const broken = parsed?.rows.filter((r) => r.errors.length > 0) ?? [];
  const canImport = !!parsed && parsed.fileErrors.length === 0 && ready.length > 0 && !running;

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const readFile = (f: File) => {
    setFileName(f.name);
    setResults(null);
    setError('');
    f.text().then(setText).catch(() => setError('Could not read that file.'));
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mikrotik-manager-devices.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const poll = async (id: string) => {
    try {
      const { data } = await devicesApi.bulkAddStatus(id);
      setProgress({ done: data.processed ?? 0, total: data.total ?? ready.length, current: data.current_name ?? '' });
      if (Array.isArray(data.results)) setResults(data.results);
      if (['completed', 'failed', 'cancelled'].includes(String(data.status))) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setRunning(false);
        if (data.status === 'failed' && data.error) setError(String(data.error));
        if (data.results?.some((r) => r.ok)) onSuccess();
      }
    } catch {
      // transient; the next tick retries
    }
  };

  const runImport = async () => {
    setError('');
    setResults(null);
    setRunning(true);
    try {
      const items = ready.map((r) => r.item!);
      const { data } = await devicesApi.bulkAddEnqueue(items);
      setProgress({ done: 0, total: data.total, current: '' });
      await poll(data.job_id);
      pollRef.current = setInterval(() => void poll(data.job_id), 1200);
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not start the import.');
      setRunning(false);
    }
  };

  const okCount = results?.filter((r) => r.ok).length ?? 0;
  const failCount = results?.filter((r) => !r.ok).length ?? 0;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-500" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Import devices from CSV</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-[13px] text-gray-600 dark:text-slate-300">
            One device per row. Columns: <span className="mono">ip_address</span> (required),
            <span className="mono"> name</span>, <span className="mono">type</span>, and either
            <span className="mono"> preset</span> (a credential preset name) or
            <span className="mono"> username</span> and <span className="mono">password</span>.
            Optional <span className="mono">ssh_username</span>, <span className="mono">ssh_password</span>
            and <span className="mono">ssh_port</span>; leave them out and SSH uses the API login.
            Up to {MAX_ROWS} rows per file.{' '}
            <button onClick={downloadTemplate} className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 underline">
              <Download className="w-3 h-3" /> Download a template
            </button>
          </p>

          <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg p-6 cursor-pointer border-gray-300 dark:border-slate-600 hover:border-blue-400">
            <Upload className="w-5 h-5 text-gray-400" />
            <span className="text-sm text-gray-600 dark:text-slate-300">
              {fileName || 'Choose a .csv file'}
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }}
            />
          </label>

          {parsed && (
            <div className="space-y-3">
              {parsed.fileErrors.map((m) => (
                <div key={m} className="flex items-start gap-2 text-[12px] rounded p-2.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
                  <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /> {m}
                </div>
              ))}

              <div className="flex flex-wrap gap-4 text-[13px]">
                <span className="text-green-700 dark:text-green-400">{ready.length} ready to import</span>
                {skipped.length > 0 && <span className="text-gray-500">{skipped.length} already managed, skipped</span>}
                {broken.length > 0 && <span className="text-red-600 dark:text-red-400">{broken.length} with problems</span>}
              </div>

              {parsed.ignoredColumns.length > 0 && (
                <p className="text-[11.5px] text-gray-400">
                  Ignored columns: <span className="mono">{parsed.ignoredColumns.join(', ')}</span>
                </p>
              )}

              {broken.length > 0 && (
                <div className="rounded border border-gray-200 dark:border-slate-700 max-h-48 overflow-y-auto">
                  {broken.map((r) => (
                    <div key={r.line} className="flex gap-3 px-3 py-1.5 text-[12px] border-b last:border-0 border-gray-100 dark:border-slate-800">
                      <span className="mono text-gray-400 w-14 shrink-0">line {r.line}</span>
                      <span className="text-red-600 dark:text-red-400">{r.errors.join(' ')}</span>
                    </div>
                  ))}
                </div>
              )}
              {broken.length > 0 && ready.length > 0 && (
                <p className="text-[11.5px] text-gray-500">Rows with problems are left out. The rest can be imported now.</p>
              )}
            </div>
          )}

          {(running || results) && (
            <div className="rounded border border-gray-200 dark:border-slate-700 p-3 space-y-2">
              <div className="flex items-center gap-2 text-[13px]">
                {running ? <Loader2 className="w-4 h-4 animate-spin text-blue-500" /> : <Check className="w-4 h-4 text-green-500" />}
                <span>
                  {running
                    ? `Adding ${progress.done} of ${progress.total}${progress.current ? `: ${progress.current}` : ''}`
                    : `Done: ${okCount} added${failCount ? `, ${failCount} failed` : ''}`}
                </span>
              </div>
              {running && (
                <p className="text-[11.5px] text-gray-400">
                  This runs on the server. You can close this dialog and it will keep going.
                </p>
              )}
              {results && failCount > 0 && (
                <div className="max-h-40 overflow-y-auto">
                  {results.filter((r) => !r.ok).map((r) => (
                    <div key={r.ip} className="text-[12px] text-red-600 dark:text-red-400">
                      <span className="mono">{r.ip}</span>: {r.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <div className="text-[12px] text-red-600">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-200 dark:border-slate-700">
          <button onClick={onClose} className="btn-secondary text-[12px]">{results && !running ? 'Close' : 'Cancel'}</button>
          <button
            onClick={runImport}
            disabled={!canImport}
            className={clsx('btn-primary text-[12px] flex items-center gap-2', !canImport && 'opacity-50')}
          >
            {running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Import {ready.length > 0 ? ready.length : ''} device{ready.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
