import { useState } from 'react';
import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, X } from 'lucide-react';
import { commandsApi, sitesApi, type CommandSchedule, type CommandScheduleInput } from '../../services/api';
import type { Device, Tag } from '../../types';
import DevicePicker from '../devices/DevicePicker';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$|^[A-Za-z]{3}(-[A-Za-z]{3})?(,[A-Za-z]{3}(-[A-Za-z]{3})?)*$/;

/** What the form checks before sending; the server checks the same and more. */
export function scheduleErrors(f: CommandScheduleInput, now = new Date()): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.command.trim()) e.command = 'Enter the command to run.';
  if (f.device_ids.length + f.tag_ids.length + f.site_ids.length === 0) e.targets = 'Choose devices, a tag or a site.';
  if (f.kind === 'once') {
    const at = f.run_at ? new Date(f.run_at) : null;
    if (!at || Number.isNaN(at.getTime())) e.run_at = 'Choose a date and time.';
    else if (at.getTime() <= now.getTime()) e.run_at = 'Choose a time in the future.';
  } else if (f.kind === 'simple') {
    const s = f.simple;
    if (!s || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) e.simple = 'Choose a time of day, like 03:00.';
    else if (s.freq === 'monthly' && !((s.monthday ?? 0) >= 1 && (s.monthday ?? 0) <= 28)) e.simple = 'Choose a day from 1 to 28, so it runs every month.';
  } else {
    const fields = (f.cron ?? '').trim().split(/\s+/);
    if (fields.length !== 5) e.cron = 'Use five fields: minute, hour, day of month, month, day of week.';
    else if (!fields.every((x) => CRON_FIELD.test(x))) e.cron = 'Each field is a number, range, list, step or *.';
  }
  if (!(f.wave_size >= 1 && f.wave_size <= 50)) e.wave_size = 'Wave size is 1 to 50.';
  return e;
}

/** A datetime-local value (the browser's time) from an ISO time, and back. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function ScheduleForm({ initial, existing, tags, devices, timeZone, risky, onDone }: {
  /** From the page: the command, devices and options as they are. */
  initial: Pick<CommandScheduleInput, 'command' | 'device_ids' | 'wave_size' | 'halt_on_failure' | 'use_change_guard'>;
  existing?: CommandSchedule | null;
  tags: Tag[];
  devices: Device[];
  timeZone: string;
  /** The preview found the command can cut management. */
  risky: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data) });
  const [f, setF] = useState<CommandScheduleInput>(() => existing ? {
    name: existing.name, command: existing.command, device_ids: existing.device_ids, tag_ids: existing.tag_ids, site_ids: existing.site_ids,
    wave_size: existing.wave_size, halt_on_failure: existing.halt_on_failure, use_change_guard: existing.use_change_guard,
    maintenance_only: existing.maintenance_only, alert_on_failure: existing.alert_on_failure,
    kind: existing.kind, run_at: existing.run_at, cron: existing.cron, simple: existing.simple ?? { freq: 'daily', time: '03:00' },
  } : {
    name: '', ...initial, tag_ids: [], site_ids: [], maintenance_only: false, alert_on_failure: true,
    kind: 'simple', run_at: null, cron: '0 3 * * *', simple: { freq: 'daily', time: '03:00' },
  });
  const [serverError, setServerError] = useState('');
  const set = (patch: Partial<CommandScheduleInput>) => { setF((x) => ({ ...x, ...patch })); setServerError(''); };
  const errs = scheduleErrors(f);
  if (risky && !f.use_change_guard) errs.use_change_guard = 'This command can cut management, so a scheduled run needs Change Guard on.';

  const body = (): CommandScheduleInput => ({ ...f, simple: f.kind === 'simple' ? f.simple : null, cron: f.kind === 'cron' ? f.cron : null, run_at: f.kind === 'once' ? f.run_at : null });
  const save = useMutation({
    mutationFn: () => (existing ? commandsApi.updateSchedule(existing.id, body()) : commandsApi.createSchedule(body())),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['command-schedules'] }); onDone(); },
    onError: (e: unknown) => setServerError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not save'),
  });

  const toggle = (key: 'tag_ids' | 'site_ids', id: number) => set({ [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id] });
  const err = (k: string) => errs[k] && <p className="text-xs text-red-500 mt-1">{errs[k]}</p>;
  const simple = f.simple ?? { freq: 'daily' as const, time: '03:00' };

  return (
    <div className="card p-5 space-y-4 border-blue-200 dark:border-blue-900/60">
      <div className="flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-blue-500" />
        <h2 className="text-sm font-semibold text-gray-800 dark:text-slate-100">{existing ? 'Edit schedule' : 'Schedule this command'}</h2>
        <button onClick={onDone} className="ml-auto p-1 text-gray-400 hover:text-gray-600" title="Close"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs">
          <span className="text-gray-500 dark:text-slate-400">Name</span>
          <input className="input mt-1 w-full text-sm" maxLength={120} value={f.name} placeholder={f.command.split('\n')[0] || 'Nightly backup'}
            onChange={(e) => set({ name: e.target.value })} />
        </label>
        {existing && (
          <label className="text-xs sm:col-span-2">
            <span className="text-gray-500 dark:text-slate-400">Command</span>
            <textarea className="input mt-1 w-full font-mono text-sm" rows={3} spellCheck={false} value={f.command} onChange={(e) => set({ command: e.target.value })} />
            {err('command')}
          </label>
        )}
      </div>

      <div className="space-y-2">
        {existing && <DevicePicker devices={devices} selected={f.device_ids} onChange={(ids) => set({ device_ids: ids })} maxHeight="max-h-48" />}
        <div className="text-xs text-gray-500 dark:text-slate-400">
          Runs on {f.device_ids.length ? `the ${f.device_ids.length} device${f.device_ids.length === 1 ? '' : 's'} ${existing ? 'picked' : 'chosen above'}` : `no devices ${existing ? 'picked' : 'chosen above'}`}, plus
          every device with these tags or in these sites <em>at the time it runs</em>, so devices added later are included.
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <button key={`t${t.id}`} onClick={() => toggle('tag_ids', t.id)} title={`Every device tagged ${t.name}`}
              className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border', f.tag_ids.includes(t.id) ? 'border-current' : 'border-transparent opacity-70')}
              style={{ background: `${t.color}22`, color: t.color }}>
              <span className="w-2 h-2 rounded-full" style={{ background: t.color }} />{t.name}
            </button>
          ))}
          {sites.map((s) => (
            <button key={`s${s.id}`} onClick={() => toggle('site_ids', s.id)} title={`Every device in ${s.name}`}
              className={clsx('px-2 py-0.5 rounded-full text-[11px] font-medium border',
                f.site_ids.includes(s.id) ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300')}>
              {s.name}
            </button>
          ))}
        </div>
        {err('targets')}
      </div>

      <div className="space-y-2">
        <div className="flex gap-2" role="radiogroup" aria-label="When">
          {([['once', 'Once'], ['simple', 'Simple'], ['cron', 'Advanced (cron)']] as const).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={f.kind === k} onClick={() => set({ kind: k })}
              className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border', f.kind === k ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300')}>
              {label}
            </button>
          ))}
        </div>
        {f.kind === 'once' && (
          <label className="text-xs block">
            <span className="text-gray-500 dark:text-slate-400">At (your browser&rsquo;s time)</span>
            <input type="datetime-local" className="input mt-1 text-sm" value={toLocalInput(f.run_at)}
              onChange={(e) => set({ run_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
            {err('run_at')}
          </label>
        )}
        {f.kind === 'simple' && (
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <select className="input text-sm w-auto" value={simple.freq}
              onChange={(e) => set({ simple: { freq: e.target.value as 'daily' | 'weekly' | 'monthly', time: simple.time, ...(e.target.value === 'weekly' ? { weekday: 1 } : {}), ...(e.target.value === 'monthly' ? { monthday: 1 } : {}) } })}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
            {simple.freq === 'weekly' && (
              <select className="input text-sm w-auto" value={simple.weekday ?? 1} onChange={(e) => set({ simple: { ...simple, weekday: Number(e.target.value) } })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>on {d}</option>)}
              </select>
            )}
            {simple.freq === 'monthly' && (
              <select className="input text-sm w-auto" value={simple.monthday ?? 1} onChange={(e) => set({ simple: { ...simple, monthday: Number(e.target.value) } })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>on day {d}</option>)}
              </select>
            )}
            <span className="pb-2 text-gray-500">at</span>
            <input type="time" className="input text-sm w-auto" value={simple.time} onChange={(e) => set({ simple: { ...simple, time: e.target.value } })} />
            <span className="pb-2 text-gray-500">{timeZone}</span>
            {err('simple')}
          </div>
        )}
        {f.kind === 'cron' && (
          <label className="text-xs block">
            <span className="text-gray-500 dark:text-slate-400">Minute, hour, day of month, month, day of week, in {timeZone}</span>
            <input className="input mt-1 w-64 font-mono text-sm" value={f.cron ?? ''} placeholder="*/30 2-5 * * 1-5" onChange={(e) => set({ cron: e.target.value })} />
            <span className="block text-[11px] text-gray-400 dark:text-slate-500 mt-1">For example <span className="mono">0 3 * * 1-5</span> is 03:00 on weekdays; <span className="mono">*/15 * * * *</span> is every 15 minutes.</span>
            {err('cron')}
          </label>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={f.maintenance_only} onChange={(e) => set({ maintenance_only: e.target.checked })} />
          <span className="text-gray-700 dark:text-slate-300">Only inside a maintenance window
            <span className="block text-[11px] text-gray-400 dark:text-slate-500">A device outside one when it runs is skipped.</span></span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={f.alert_on_failure} onChange={(e) => set({ alert_on_failure: e.target.checked })} />
          <span className="text-gray-700 dark:text-slate-300">Alert when it fails or doesn&rsquo;t run
            <span className="block text-[11px] text-gray-400 dark:text-slate-500">Through your alert channels (Settings → Alerting).</span></span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={f.use_change_guard} onChange={(e) => set({ use_change_guard: e.target.checked })} />
          <span className="text-gray-700 dark:text-slate-300">Change Guard
            <span className="block text-[11px] text-gray-400 dark:text-slate-500">A device that stops answering restores itself.</span>
            {err('use_change_guard')}</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={f.halt_on_failure} onChange={(e) => set({ halt_on_failure: e.target.checked })} />
          <span className="text-gray-700 dark:text-slate-300">Stop at the first failure, {f.wave_size} device{f.wave_size === 1 ? '' : 's'} per wave</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary text-sm" disabled={Object.keys(errs).length > 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : existing ? 'Save schedule' : 'Create schedule'}
        </button>
        <button className="btn-secondary text-sm" onClick={onDone}>Cancel</button>
        {serverError && <span className="text-xs text-red-600 dark:text-red-400">{serverError}</span>}
      </div>
    </div>
  );
}
