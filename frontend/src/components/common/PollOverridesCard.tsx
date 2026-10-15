import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { devicesApi, sitesApi, type PollSettings } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import NumberSetting from '../settings/NumberSetting';

export type PollRow = { key: string; label: string; unit?: string; min?: number; max?: number; bool?: boolean; dependsOn?: string };

export const POLL_ROWS: PollRow[] = [
  { key: 'polling_fast_interval', label: 'Fast poll (interface stats, clients)', unit: 's', min: 10, max: 3600 },
  { key: 'polling_slow_interval', label: 'Slow poll (config, VLANs, neighbours)', unit: 's', min: 60, max: 86400 },
  { key: 'polling_logs_interval', label: 'Log poll (events)', unit: 's', min: 10, max: 86400 },
  { key: 'mac_scan_enabled', label: 'MAC scan (switches)', bool: true },
  { key: 'mac_scan_interval', label: 'MAC scan interval', unit: 's', min: 60, max: 86400, dependsOn: 'mac_scan_enabled' },
  { key: 'config_snapshot_enabled', label: 'Config snapshots', bool: true },
  { key: 'config_snapshot_interval_min', label: 'Config snapshot interval', unit: 'min', min: 5, max: 10080, dependsOn: 'config_snapshot_enabled' },
  { key: 'backup_include_secrets', label: 'Include passwords and keys in backups', bool: true },
];

/**
 * Settings a site or a device overrides (#261): each shows the value in force
 * and where it comes from, and an admin can override it here or go back to
 * inheriting it.
 */
/** Fleet admins, or a site admin for this site, may change these (#261). */
export function useCanEditPollSettings(siteId: number | null | undefined): boolean {
  const user = useAuthStore((s) => s.user) as { role?: string; siteRoles?: Record<string, string> | null } | null;
  return user?.siteRoles && Object.keys(user.siteRoles).length > 0
    ? siteId != null && user.siteRoles[String(siteId)] === 'admin'
    : user?.role === 'admin';
}

export default function PollOverridesCard({ scope, id, siteId, compact = false }: {
  scope: 'site' | 'device'; id: number; siteId: number | null;
  /** Inside another form (Edit Device): no card around it. */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const canEdit = useCanEditPollSettings(siteId);
  const key = ['poll-settings', scope, id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => (scope === 'site' ? sitesApi.getPollSettings(id) : devicesApi.getPollSettings(id)).then((r) => r.data),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, number | boolean | null>) =>
      (scope === 'site' ? sitesApi.setPollSettings(id, body) : devicesApi.setPollSettings(id, body)).then((r) => r.data),
    onSuccess: (d: PollSettings) => {
      qc.setQueryData(key, d);
      qc.invalidateQueries({ queryKey: ['poll-settings'] });
    },
  });
  if (!data) return null;

  const fromWhere = (src: string) =>
    src === 'device' ? 'this device' : src === 'site' ? (scope === 'device' ? `site ${data.site?.name ?? ''}`.trim() : 'this site') : 'global';
  const show = (v: number | boolean, unit?: string) => (typeof v === 'boolean' ? (v ? 'On' : 'Off') : `${v}${unit ? ` ${unit}` : ''}`);

  return (
    <div className={compact ? '' : 'card p-5'}>
      {!compact && <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Polling and backups</h3>}
      <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
        {scope === 'site'
          ? 'Devices in this site use these instead of the global settings, unless a device overrides them itself.'
          : 'Only for a device that needs to differ from its site, such as one on a slow backup link. Each change saves straight away.'}
      </p>
      <div className="space-y-2.5">
        {POLL_ROWS.map((r) => {
          const eff = data.effective[r.key];
          if (!eff) return null;
          const own = r.key in data.overrides;
          const off = r.dependsOn && data.effective[r.dependsOn]?.value === false;
          return (
            <div key={r.key} className={`flex items-center justify-between gap-3 ${off ? 'opacity-50' : ''}`}>
              <div className="min-w-0">
                <div className="text-sm text-gray-700 dark:text-slate-300">{r.label}</div>
                <div className="text-xs text-gray-400">
                  {show(eff.value, r.unit)} · {own ? 'set here' : `from ${fromWhere(eff.source)}`}
                </div>
              </div>
              {canEdit && (
                <div className="flex items-center gap-2 flex-shrink-0">
                  {own && (r.bool ? (
                    <select className="input py-1 text-sm w-20" value={eff.value ? 'on' : 'off'}
                      onChange={(e) => save.mutate({ [r.key]: e.target.value === 'on' })}>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  ) : (
                    <NumberSetting className="input py-1 w-24 text-center" value={eff.value as number} min={String(r.min)} max={String(r.max)}
                      onCommit={(v) => save.mutate({ [r.key]: v })} />
                  ))}
                  {/* type="button": inside the Edit device form a plain button
                      submitted it, closing the dialog (#261). */}
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:underline w-14 text-right"
                    onClick={() => save.mutate({ [r.key]: own ? null : eff.value })}
                  >
                    {own ? 'Inherit' : 'Override'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {save.isError && <p className="text-xs text-red-600 mt-2">{(save.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Couldn’t save'}</p>}
    </div>
  );
}
