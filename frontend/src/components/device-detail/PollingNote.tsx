import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { devicesApi } from '../../services/api';
import PollOverridesCard, { useCanEditPollSettings } from '../common/PollOverridesCard';

const LABELS: Record<string, { label: string; unit?: string }> = {
  polling_fast_interval: { label: 'fast poll', unit: 's' },
  polling_slow_interval: { label: 'slow poll', unit: 's' },
  polling_logs_interval: { label: 'log poll', unit: 's' },
  mac_scan_enabled: { label: 'MAC scan' },
  mac_scan_interval: { label: 'MAC scan every', unit: 's' },
  config_snapshot_enabled: { label: 'config snapshots' },
  config_snapshot_interval_min: { label: 'snapshots every', unit: 'min' },
  backup_include_secrets: { label: 'secrets in backups' },
};

/**
 * Shown only when this device doesn't use the global polling and backup
 * settings (#261): what differs and where it's set, so a device that polls
 * differently is never a mystery. **Edit** opens the same overrides editor as
 * Edit Device → Advanced, here on the Overview.
 */
export default function PollingNote({ deviceId, siteId }: { deviceId: number; siteId: number | null }) {
  const [editing, setEditing] = useState(false);
  const canEdit = useCanEditPollSettings(siteId);
  const { data } = useQuery({
    queryKey: ['poll-settings', 'device', deviceId],
    queryFn: () => devicesApi.getPollSettings(deviceId).then((r) => r.data),
    staleTime: 60_000,
  });
  if (!data) return null;
  const differs = Object.entries(data.effective).filter(([k, e]) => e.source !== 'global' && LABELS[k]);
  // Stays open while editing, even once every override is cleared.
  if (differs.length === 0 && !editing) return null;
  const show = (v: number | boolean, unit?: string) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : `${v} ${unit ?? ''}`.trim());
  return (
    <div className="card px-4 py-2.5 text-xs text-gray-600 dark:text-slate-300">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-medium">Polling and backups set for this device or its site: </span>
          {differs.length === 0 && <span className="text-gray-400">none; this device uses the global settings.</span>}
          {differs.map(([k, e], i) => (
            <span key={k}>
              {i > 0 && ', '}
              {LABELS[k].label} {show(e.value, LABELS[k].unit)}
              <span className="text-gray-400"> ({e.source === 'device' ? 'this device' : `site ${data.site?.name ?? ''}`.trim()})</span>
            </span>
          ))}
          {!canEdit && differs.length > 0 && (
            <span className="text-gray-400">. {differs.some(([, e]) => e.source === 'device') ? 'Edit Device → Advanced' : 'Sites → edit'} to change.</span>
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="btn-secondary flex items-center gap-1.5 text-xs py-1 flex-shrink-0"
          >
            {editing ? 'Done' : <><Pencil className="w-3 h-3" /> Edit</>}
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-slate-700">
          <PollOverridesCard scope="device" id={deviceId} siteId={siteId} compact />
        </div>
      )}
    </div>
  );
}
