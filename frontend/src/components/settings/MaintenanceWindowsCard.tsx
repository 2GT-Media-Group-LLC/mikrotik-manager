import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { maintenanceApi, devicesApi, type MaintenanceWindow } from '../../services/api';
import DevicePicker from '../devices/DevicePicker';

/**
 * Maintenance windows (P2-26).
 *
 * Alerts for the chosen devices are suppressed while a window is open. The form
 * used to save an empty device list (which matched nothing, so no window ever
 * suppressed anything), send local times with no time zone, and offer no way
 * to repeat. An empty list now means all devices, times are sent in UTC, and a
 * window can repeat daily or weekly.
 */

type Repeat = 'none' | 'daily' | 'weekly';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Hour, minute and weekday of `d` in `timeZone`, for building the repeat's cron. */
function partsIn(d: Date, timeZone: string): { hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

function cronFor(repeat: Repeat, start: Date, timeZone: string): string | null {
  if (repeat === 'none') return null;
  const { hour, minute, weekday } = partsIn(start, timeZone);
  return repeat === 'daily' ? `${minute} ${hour} * * *` : `${minute} ${hour} * * ${weekday}`;
}

/** "Every Sunday at 02:00" for the crons this form writes; the raw cron otherwise. */
function describeRepeat(cron: string, timeZone: string): string {
  const m = cron.trim().match(/^(\d+) (\d+) \* \* (\*|\d)$/);
  if (!m) return `Repeats (${cron})`;
  const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  const day = m[3] === '*' ? 'Every day' : `Every ${WEEKDAYS[Number(m[3]) % 7]}`;
  return `${day} at ${time} (${timeZone})`;
}

function formatSpan(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export default function MaintenanceWindowsCard({ isAdmin, timeZone }: { isAdmin: boolean; timeZone: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', start: '', end: '', repeat: 'none' as Repeat });
  const [deviceIds, setDeviceIds] = useState<number[]>([]);
  const [error, setError] = useState('');

  const { data: windows = [] } = useQuery({
    queryKey: ['maintenance-windows'],
    queryFn: () => maintenanceApi.list().then((r) => r.data),
  });
  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
    enabled: isAdmin,
  });
  const deviceName = (id: number) => devices.find((d) => d.id === id)?.name ?? `#${id}`;

  const create = useMutation({
    mutationFn: () => {
      const start = new Date(form.start);
      const end = new Date(form.end);
      return maintenanceApi.create({
        name: form.name.trim(),
        device_ids: deviceIds,
        // datetime-local has no zone; converting here sends the moment the user meant.
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        recurring_cron: cronFor(form.repeat, start, timeZone),
        active: true,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
      setForm({ name: '', start: '', end: '', repeat: 'none' });
      setDeviceIds([]);
      setError('');
    },
    onError: (e: unknown) =>
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not create the window'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => maintenanceApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance-windows'] }),
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => maintenanceApi.update(id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance-windows'] }),
  });

  const endsBeforeStart = form.start && form.end && new Date(form.end) <= new Date(form.start);

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Maintenance Windows</h3>
      <p className="text-xs text-gray-500 dark:text-slate-400 mb-4">
        Alerts for the chosen devices are held back while a window is open, so planned reboots and
        upgrades don&apos;t page anyone.
      </p>

      {isAdmin && (
        <div className="space-y-3 mb-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input type="text" placeholder="Window name, e.g. Sunday reboots" value={form.name}
                   onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="input text-sm" />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 dark:text-slate-400">Start</label>
              <input type="datetime-local" value={form.start}
                     onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))} className="input text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 dark:text-slate-400">End</label>
              <input type="datetime-local" value={form.end}
                     onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} className="input text-sm" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="text-xs text-gray-500 dark:text-slate-400">Repeat</label>
            <select className="input text-sm w-auto" value={form.repeat}
                    onChange={(e) => setForm((f) => ({ ...f, repeat: e.target.value as Repeat }))}>
              <option value="none">Just once</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week, same day</option>
            </select>
            {form.repeat !== 'none' && form.start && (
              <span className="text-xs text-gray-500 dark:text-slate-400">
                {describeRepeat(cronFor(form.repeat, new Date(form.start), timeZone)!, timeZone)}, starting {new Date(form.start).toLocaleDateString()}
              </span>
            )}
          </div>

          <details className="rounded border border-gray-200 dark:border-slate-700">
            <summary className="cursor-pointer px-3 py-2 text-sm text-gray-700 dark:text-slate-300">
              Devices: {deviceIds.length === 0 ? <strong>All devices</strong> : <strong>{deviceIds.length} selected</strong>}
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-1.5">
              <DevicePicker devices={devices} selected={deviceIds} onChange={setDeviceIds} maxHeight="max-h-56" />
              {deviceIds.length > 0 && (
                <button type="button" className="text-xs text-blue-600 text-left" onClick={() => setDeviceIds([])}>
                  Clear, to cover all devices
                </button>
              )}
            </div>
          </details>

          {endsBeforeStart && <p className="text-xs text-red-600">The window must end after it starts.</p>}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            onClick={() => create.mutate()}
            disabled={!form.name.trim() || !form.start || !form.end || !!endsBeforeStart || create.isPending}
            className="btn-primary text-sm flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Create window
          </button>
        </div>
      )}

      <div className="space-y-2">
        {(windows as MaintenanceWindow[]).map((mw) => {
          const now = new Date();
          const start = new Date(mw.start_at);
          const end = new Date(mw.end_at);
          const repeating = !!mw.recurring_cron;
          const isActive = !repeating && mw.active && now >= start && now <= end;
          const isPast = !repeating && now > end;
          return (
            <div key={mw.id} className={clsx('flex items-center justify-between p-3 rounded-lg',
              isActive ? 'border border-yellow-400 dark:border-yellow-600' : '')} style={{ background: 'var(--surface-2)' }}>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">{mw.name}</span>
                  {isActive && <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">Active</span>}
                  {isPast && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400">Expired</span>}
                  {!mw.active && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 dark:bg-slate-700 dark:text-slate-500">Disabled</span>}
                </div>
                <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                  {repeating
                    ? `${describeRepeat(mw.recurring_cron!, timeZone)} for ${formatSpan(end.getTime() - start.getTime())}, from ${start.toLocaleDateString()}`
                    : `${start.toLocaleString()} – ${end.toLocaleString()}`}
                  {' · '}
                  {mw.device_ids.length === 0
                    ? 'All devices'
                    : mw.device_ids.length <= 3
                      ? mw.device_ids.map(deviceName).join(', ')
                      : `${mw.device_ids.length} devices`}
                </div>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <button onClick={() => toggle.mutate({ id: mw.id, active: !mw.active })}
                          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300">
                    {mw.active ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => { if (confirm(`Delete the maintenance window "${mw.name}"?`)) remove.mutate(mw.id); }}
                          className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors" aria-label="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {(windows as MaintenanceWindow[]).length === 0 && (
          <p className="text-sm text-gray-400 dark:text-slate-500 text-center py-4">No maintenance windows yet</p>
        )}
      </div>
    </div>
  );
}
