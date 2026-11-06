import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Inbox, RefreshCw, Trash2 } from 'lucide-react';
import { smsApi } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { apiErrorMessage } from '../../utils/apiError';

/**
 * The modem's SMS inbox (discussion #85): carriers answer the data-cap SMS,
 * sometimes many times a day, and the replies fill the SIM. Read live from the
 * device and never stored; only users who can change the device see it, since
 * a text can hold anything.
 */
export default function SmsInboxCard({ deviceId }: { deviceId: number }) {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['lte-sms', deviceId],
    queryFn: () => smsApi.inbox(deviceId).then((r) => r.data),
    enabled: canWrite && open,
    retry: false,
  });
  const remove = useMutation({
    mutationFn: (body: { ids?: string[]; phone?: string; all?: true }) => smsApi.remove(deviceId, body),
    onSuccess: (r) => { setNote({ ok: true, text: r.data.message }); qc.invalidateQueries({ queryKey: ['lte-sms', deviceId] }); },
    onError: (e) => setNote({ ok: false, text: apiErrorMessage(e) }),
  });
  if (!canWrite) return null;
  const messages = data?.messages ?? [];
  const senders = [...new Set(messages.map((m) => m.phone))];

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4 space-y-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 text-left">
        <Inbox className="w-5 h-5 text-gray-400 dark:text-slate-500" />
        <h3 className="font-semibold text-gray-900 dark:text-white flex-1">
          SMS inbox{data ? <span className="text-gray-400 font-normal text-sm"> ({messages.length})</span> : null}
        </h3>
        <span className="text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(error)}</p> : null}
          {data && data.receive_enabled === false && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Receiving is off on this modem (<span className="font-mono">/tool sms set receive-enabled=yes</span>), so new messages stay on the SIM and don&apos;t show here.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => { setNote(null); refetch(); }} disabled={isFetching} className="btn-secondary text-xs flex items-center gap-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </button>
            {senders.length > 1 && senders.map((p) => (
              <button key={p} onClick={() => remove.mutate({ phone: p })} disabled={remove.isPending}
                className="btn-secondary text-xs" title={`Delete every message from ${p}`}>
                Delete all from <span className="font-mono">{p}</span>
              </button>
            ))}
            {messages.length > 0 && (
              <button onClick={() => { if (window.confirm(`Delete all ${messages.length} messages from the modem?`)) remove.mutate({ all: true }); }}
                disabled={remove.isPending} className="btn-secondary text-xs text-red-600 ml-auto">Delete all</button>
            )}
          </div>
          {note && <p className={`text-xs ${note.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{note.text}</p>}
          {data && messages.length === 0 && <p className="text-sm text-gray-400">The inbox is empty.</p>}
          {messages.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-slate-700 border border-gray-200 dark:border-slate-700 rounded-lg">
              {messages.map((m) => (
                <li key={m.id} className="flex items-start gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-x-2 text-gray-500 dark:text-slate-400">
                      <span className="font-mono text-gray-800 dark:text-slate-200">{m.phone || 'unknown sender'}</span>
                      {m.timestamp && <span>{m.timestamp}</span>}
                    </div>
                    <p className="text-gray-700 dark:text-slate-300 whitespace-pre-wrap break-words mt-0.5">{m.message}</p>
                  </div>
                  <button onClick={() => remove.mutate({ ids: [m.id] })} disabled={remove.isPending} title="Delete this message"
                    className="text-gray-400 hover:text-red-500 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
