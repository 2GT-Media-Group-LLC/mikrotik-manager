import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Radio, Loader2 } from 'lucide-react';
import { firmwareApi, settingsApi, type FirmwareDeviceRow } from '../../services/api';

/**
 * RouterOS update channel: a fleet default, plus overrides for a tag or a
 * single device (#162).
 *
 * Tags are the groups here, the same as in Bulk Commands and the rollout wave
 * picker, so a per-group channel needs no separate concept. Changes take effect
 * at each device's next update check, which also records the channel the
 * device reports back.
 */

const CHANNELS = ['stable', 'long-term', 'testing', 'development'];

interface Props {
  devices: FirmwareDeviceRow[];
  canWrite: boolean;
}

export default function UpdateChannelCard({ devices, canWrite }: Props) {
  const qc = useQueryClient();
  const [target, setTarget] = useState('');
  const [channel, setChannel] = useState<string>('stable');
  const [message, setMessage] = useState('');

  const { data: settings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsApi.get().then((r) => r.data),
    staleTime: 300_000,
  });
  const fleet = typeof settings?.['firmware_update_channel'] === 'string'
    ? (settings['firmware_update_channel'] as string) : '';

  const tags = useMemo(() => {
    const m = new Map<number, { id: number; name: string; ids: number[] }>();
    for (const d of devices) for (const t of d.tags ?? []) {
      const e = m.get(t.id) ?? { id: t.id, name: t.name, ids: [] };
      e.ids.push(d.id);
      m.set(t.id, e);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [devices]);

  const reported = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of devices) {
      const k = d.reported_update_channel || 'not yet checked';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()];
  }, [devices]);
  const overrides = devices.filter((d) => d.update_channel).length;

  const saveFleet = useMutation({
    mutationFn: (v: string) => settingsApi.update({ firmware_update_channel: v || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const targetIds = (): number[] => {
    if (target.startsWith('tag:')) return tags.find((t) => `tag:${t.id}` === target)?.ids ?? [];
    if (target.startsWith('dev:')) return [Number(target.slice(4))];
    return [];
  };

  const applyOverride = useMutation({
    mutationFn: () => firmwareApi.setChannel(targetIds(), channel === 'fleet' ? null : channel),
    onSuccess: (r) => {
      setMessage(`${r.data.updated} device${r.data.updated === 1 ? '' : 's'} updated. Applies at the next update check.`);
      qc.invalidateQueries({ queryKey: ['fw-overview'] });
    },
    onError: () => setMessage('Could not save the override.'),
  });

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Radio className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Update channel</h3>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm">
          <span className="text-gray-700 dark:text-slate-300">Fleet default</span>
          <select
            className="input mt-1"
            value={fleet}
            disabled={!canWrite || saveFleet.isPending}
            onChange={(e) => saveFleet.mutate(e.target.value)}
          >
            <option value="">Leave each device on its own channel</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="block text-[11px] text-gray-400 mt-1">
            Devices are moved at their next update check. A device already running something newer
            than its channel offers is not downgraded.
          </span>
        </label>

        {canWrite && (
          <div className="text-sm">
            <span className="text-gray-700 dark:text-slate-300">Override for a tag or device</span>
            <div className="flex gap-2 mt-1">
              <select className="input flex-1 min-w-0" value={target} onChange={(e) => { setTarget(e.target.value); setMessage(''); }}>
                <option value="">Choose…</option>
                {tags.length > 0 && (
                  <optgroup label="Tags">
                    {tags.map((t) => <option key={t.id} value={`tag:${t.id}`}>{t.name} ({t.ids.length})</option>)}
                  </optgroup>
                )}
                <optgroup label="Devices">
                  {devices.map((d) => <option key={d.id} value={`dev:${d.id}`}>{d.name.trim()}</option>)}
                </optgroup>
              </select>
              <select className="input w-auto" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="fleet">follow fleet default</option>
              </select>
              <button
                className="btn-primary text-[12px] flex items-center gap-1 disabled:opacity-50"
                disabled={!target || applyOverride.isPending}
                onClick={() => applyOverride.mutate()}
              >
                {applyOverride.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                Apply
              </button>
            </div>
            {message && <span className="block text-[11.5px] text-gray-500 mt-1">{message}</span>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-gray-500 dark:text-slate-400">
        <span>Devices report:</span>
        {reported.map(([ch, n]) => <span key={ch}><span className="mono">{ch}</span> {n}</span>)}
        {overrides > 0 && <span>· {overrides} with an override</span>}
      </div>
    </div>
  );
}
