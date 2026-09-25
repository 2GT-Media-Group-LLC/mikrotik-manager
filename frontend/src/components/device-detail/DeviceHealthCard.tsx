import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HeartPulse, AlertTriangle, CheckCircle2, EyeOff, Eye, Loader2 } from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { Device, HealthIssue } from '../../types';
import { useCanWrite } from '../../hooks/useCanWrite';

/**
 * Hardware health and "expected to drop out" for one device (#168).
 *
 * Health comes from /system/health on the slow poll. A reading can be ignored
 * here, for the case where a problem is deliberate: a dual-supply switch fed
 * from one supply reports the other as failed forever.
 */
export default function DeviceHealthCard({ device }: { device: Device }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const issues: HealthIssue[] = device.health_issues?.issues ?? [];
  const ignoredIssues: HealthIssue[] = device.health_issues?.ignored ?? [];
  const ignoredNames = device.health_ignored ?? [];

  // A draft while typing; otherwise the saved value.
  const [hoursDraft, setHoursDraft] = useState<string | null>(null);
  const hours = hoursDraft ?? String(Math.round((device.intermittent_alert_after_min ?? 1440) / 60));

  const save = useMutation({
    mutationFn: (data: Parameters<typeof devicesApi.patchMonitoring>[1]) => devicesApi.patchMonitoring(device.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device', device.id] });
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  const setIgnored = (item: string, ignore: boolean) =>
    save.mutate({
      health_ignored: ignore ? [...ignoredNames, item] : ignoredNames.filter((n) => n !== item),
    });

  const status = device.health_status;

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <HeartPulse className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex-1">Hardware health</h3>
        {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
      </div>

      {status === 'degraded' ? (
        <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="w-4 h-4" /> Degraded
          </div>
          {issues.map((i) => (
            <div key={i.item} className="flex items-center gap-3 text-sm">
              <span className="flex-1">{i.message}</span>
              {canWrite && (
                <button
                  onClick={() => setIgnored(i.item, true)}
                  disabled={save.isPending}
                  className="flex items-center gap-1 text-xs underline"
                  title="Use this if the problem is deliberate, e.g. a second power supply that isn't connected"
                >
                  <EyeOff className="w-3 h-3" /> Ignore on this device
                </button>
              )}
            </div>
          ))}
        </div>
      ) : status === 'ok' ? (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 className="w-4 h-4" /> Power supplies, fans and temperatures are fine.
        </div>
      ) : (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          {device.health_checked_at
            ? 'This device reports no power supply, fan or temperature readings.'
            : 'Not checked yet. Health is read every few minutes while the device is online.'}
        </p>
      )}

      {ignoredIssues.length > 0 && (
        <div className="text-xs text-gray-500 dark:text-slate-400 space-y-1">
          <div>Ignored on this device:</div>
          {ignoredIssues.map((i) => (
            <div key={i.item} className="flex items-center gap-3">
              <span className="flex-1">{i.message}</span>
              {canWrite && (
                <button onClick={() => setIgnored(i.item, false)} disabled={save.isPending} className="flex items-center gap-1 underline">
                  <Eye className="w-3 h-3" /> Stop ignoring
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="pt-3 border-t border-gray-100 dark:border-slate-700 space-y-2">
        <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-slate-200">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={!!device.intermittent}
            disabled={!canWrite || save.isPending}
            onChange={(e) => save.mutate({ intermittent: e.target.checked })}
          />
          <span>
            Expected to go offline at times
            <span className="block text-xs text-gray-500 dark:text-slate-400">
              For solar or battery powered devices, or anything that drops out normally. Shown grey
              instead of red when offline, with no alert each time.
            </span>
          </span>
        </label>
        {device.intermittent && (
          <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 pl-6">
            Alert if offline for more than
            <input
              type="number"
              min={0}
              className="input w-20 py-1 text-sm"
              value={hours}
              disabled={!canWrite}
              onChange={(e) => setHoursDraft(e.target.value)}
              onBlur={() => {
                setHoursDraft(null);
                const h = Number(hours);
                if (Number.isFinite(h) && h >= 0 && Math.round(h * 60) !== device.intermittent_alert_after_min) {
                  save.mutate({ intermittent_alert_after_min: Math.round(h * 60) });
                }
              }}
            />
            hours <span className="text-xs text-gray-500">(0 = never)</span>
          </div>
        )}
      </div>

      {save.isError && <div className="text-sm text-red-600">Could not save.</div>}
    </div>
  );
}
