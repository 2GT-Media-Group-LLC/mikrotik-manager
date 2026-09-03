import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Terminal, AlertTriangle, Play, ShieldCheck, ChevronDown, ChevronRight, Ban, Download } from 'lucide-react';
import { commandsApi, devicesApi, type CommandRunDetail } from '../services/api';

/**
 * Bulk command execution.
 *
 * The controls here are the feature. A shell loop already runs a command on many
 * hosts; what it cannot do is stop after the first wave once it becomes clear the
 * command was wrong. Wave size and halt-on-failure are therefore prominent, and
 * the guards default on — with a single deliberate switch to turn them off,
 * because a tool that refuses to cut is not a sharp tool (#118).
 */

/**
 * Pull the CSV through the authenticated client and hand it to the browser.
 *
 * A plain download link cannot carry the Bearer header, so it would 401.
 */
async function downloadCsv(runId: number): Promise<void> {
  const res = await commandsApi.exportCsv(runId);
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `command-run-${runId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function CommandsPage() {
  const queryClient = useQueryClient();
  const [command, setCommand] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [waveSize, setWaveSize] = useState(1);
  const [haltOnFailure, setHaltOnFailure] = useState(true);
  const [useGuard, setUseGuard] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
  });

  const { data: runs = [] } = useQuery({
    queryKey: ['command-runs'],
    queryFn: () => commandsApi.listRuns().then(r => r.data),
    refetchInterval: 5_000,
  });

  const { data: detail } = useQuery<CommandRunDetail>({
    queryKey: ['command-run', openRun],
    queryFn: () => commandsApi.getRun(openRun!).then(r => r.data),
    enabled: openRun != null,
    refetchInterval: 3_000,
  });

  const { data: preview } = useQuery({
    queryKey: ['command-preview', command, selected, waveSize],
    queryFn: () => commandsApi.preview(command, selected, waveSize).then(r => r.data),
    enabled: command.trim().length > 0 && selected.length > 0,
  });

  const startRun = useMutation({
    mutationFn: () => commandsApi.createRun({
      name: command.slice(0, 60), command, device_ids: selected,
      wave_size: waveSize, halt_on_failure: haltOnFailure,
      use_change_guard: useGuard, start: true,
    }),
    onSuccess: (r) => {
      setOpenRun(r.data.id);
      setAcknowledged(false);
      queryClient.invalidateQueries({ queryKey: ['command-runs'] });
    },
  });

  const toggle = (id: number) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const risky = preview?.risky ?? false;
  // Guards off on a command that can sever management is the one combination
  // worth insisting the operator states out loud.
  const needsAck = risky && !useGuard;
  const canRun = command.trim() && selected.length > 0 && (!needsAck || acknowledged) && !startRun.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <Terminal className="w-5 h-5 text-blue-500" /> Bulk commands
        </h1>
        <p className="text-sm text-gray-600 dark:text-slate-300 mt-1 max-w-3xl">
          Run one RouterOS console command across many devices, in waves, stopping at the first
          failure. Commands run over SSH, so console syntax such as <code>:put</code> works.
        </p>
      </div>

      <div className="card p-5 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Command</span>
          <textarea
            value={command} onChange={e => setCommand(e.target.value)}
            rows={2} spellCheck={false}
            placeholder="/system note set note=&quot;maintenance window&quot;"
            className="input mt-1 w-full font-mono text-sm"
          />
        </label>

        {risky && (
          <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700/60 dark:bg-amber-900/20">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div className="text-amber-800 dark:text-amber-300">
              <div className="font-medium">This command can cut management access.</div>
              <ul className="mt-1 list-disc list-inside">
                {preview?.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
              <p className="mt-1">
                It is not blocked — you may know exactly why you are running it. With Change Guard on,
                a device that stops answering afterwards restores itself.
              </p>
            </div>
          </div>
        )}

        {/* Devices */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700 dark:text-slate-300">
              Devices {selected.length > 0 && `(${selected.length} selected)`}
            </span>
            <div className="flex gap-2 text-xs">
              <button className="underline text-blue-600 dark:text-blue-400"
                      onClick={() => setSelected(devices.map(d => d.id))}>All</button>
              <button className="underline text-blue-600 dark:text-blue-400"
                      onClick={() => setSelected([])}>None</button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 max-h-52 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 p-2">
            {devices.map(d => (
              <label key={d.id} className="flex items-center gap-2 text-xs px-1 py-0.5">
                <input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} />
                <span className="truncate text-gray-900 dark:text-white">{d.name.trim()}</span>
                {d.status !== 'online' && <span className="text-gray-400 text-[10px]">offline</span>}
              </label>
            ))}
          </div>
        </div>

        {/* The controls that make this different from a shell loop */}
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="text-xs">
            <span className="text-gray-500 dark:text-slate-400">Devices per wave</span>
            <input type="number" min={1} max={50} value={waveSize}
                   onChange={e => setWaveSize(Math.max(1, Number(e.target.value) || 1))}
                   className="input mt-1 w-full text-sm" />
            <span className="text-[11px] text-gray-400 dark:text-slate-500">
              {preview ? `${preview.waves} wave${preview.waves === 1 ? '' : 's'}` : 'Start small.'}
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs pt-5">
            <input type="checkbox" checked={haltOnFailure} onChange={e => setHaltOnFailure(e.target.checked)} />
            <span className="text-gray-700 dark:text-slate-300">
              Stop at the first failure
              <span className="block text-[11px] text-gray-400 dark:text-slate-500">
                The reason to run this here rather than in a loop.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs pt-5">
            <input type="checkbox" checked={useGuard} onChange={e => setUseGuard(e.target.checked)} />
            <span className="text-gray-700 dark:text-slate-300">
              Change Guard
              <span className="block text-[11px] text-gray-400 dark:text-slate-500">
                A device that stops answering restores itself.
              </span>
            </span>
          </label>
        </div>

        {needsAck && (
          <label className="flex items-start gap-2 text-xs rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-700/60 dark:bg-red-900/20">
            <input type="checkbox" className="mt-0.5" checked={acknowledged}
                   onChange={e => setAcknowledged(e.target.checked)} />
            <span className="text-red-800 dark:text-red-300">
              I am running a command that can cut management access, with Change Guard off. If a
              device becomes unreachable it will stay that way until someone attends to it physically.
            </span>
          </label>
        )}

        <div className="flex items-center gap-3">
          <button className="btn-primary text-sm flex items-center gap-2"
                  disabled={!canRun} onClick={() => startRun.mutate()}>
            <Play className="w-4 h-4" />
            {startRun.isPending ? 'Starting…' : `Run on ${selected.length || 0} device${selected.length === 1 ? '' : 's'}`}
          </button>
          {preview?.unreachable && preview.unreachable.length > 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {preview.unreachable.length} selected device(s) have no SSH credential and will fail.
            </span>
          )}
          {startRun.isError && (
            <span className="text-xs text-red-600 dark:text-red-400">
              {(startRun.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not start'}
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Recent runs</h2>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">Nothing run yet.</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-slate-800">
            {runs.map(r => (
              <div key={r.id}>
                <button className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-slate-700/40"
                        onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                  {openRun === r.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                  <span className="font-mono text-xs text-gray-900 dark:text-white truncate flex-1">{r.command}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    r.status === 'completed' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                    : r.status === 'running' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}`}>{r.status}</span>
                  <span className="text-xs text-gray-500 dark:text-slate-400 tabular-nums">
                    {r.succeeded}/{r.total}
                  </span>
                </button>

                {openRun === r.id && detail && (
                  <div className="px-5 pb-3 space-y-1">
                    <div className="flex items-center gap-2 mb-2">
                      {detail.status === 'running' && (
                        <button className="btn-secondary text-xs flex items-center gap-1.5"
                                onClick={() => commandsApi.cancelRun(r.id)}>
                          <Ban className="w-3.5 h-3.5" /> Stop before next wave
                        </button>
                      )}
                      {/* Requested on #118 for archiving and audit. */}
                      <button className="btn-secondary text-xs flex items-center gap-1.5"
                              onClick={() => downloadCsv(r.id)}>
                        <Download className="w-3.5 h-3.5" /> Export CSV
                      </button>
                    </div>
                    {detail.devices.map(d => (
                      <div key={d.id} className="text-xs border-b border-gray-100 dark:border-slate-800 last:border-0 py-1.5">
                        <button className="flex items-center gap-2 w-full text-left"
                                onClick={() => setExpanded(e => ({ ...e, [d.id]: !e[d.id] }))}>
                          <span className="text-gray-400 w-12">wave {d.wave}</span>
                          <span className="text-gray-900 dark:text-white flex-1 truncate">{d.device_name.trim()}</span>
                          {d.guarded && <ShieldCheck className="w-3 h-3 text-gray-400" />}
                          <span className={
                            d.status === 'success' ? 'text-green-600 dark:text-green-400'
                            : d.status === 'skipped' ? 'text-gray-400'
                            : 'text-red-600 dark:text-red-400'}>{d.status}</span>
                        </button>
                        {expanded[d.id] && (
                          <pre className="mt-1 ml-14 whitespace-pre-wrap break-words text-[11px] text-gray-600 dark:text-slate-300">
                            {d.error ? `${d.error}\n` : ''}{d.output || (d.status === 'success' ? '(no output)' : '')}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
