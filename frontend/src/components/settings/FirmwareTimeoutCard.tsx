import { useState } from 'react';
import { Clock, Loader2 } from 'lucide-react';

/**
 * How long a rollout waits for a device.
 *
 * Both values were hardcoded until a user reported CRS switches taking a full
 * twelve minutes to come back — which was exactly the fixed ceiling, so a
 * slightly slow board failed at the boundary. They became settings, and he
 * immediately asked the obvious follow-up: how do I set them from the UI
 * (#141). A setting nobody can reach is just a different hardcoded value.
 *
 * Clamped here and again on the server. A zero would fail every device
 * instantly; an unbounded value would hang a rollout forever on hardware that
 * is never coming back.
 */

const MIN = 1;
const MAX = 120;

interface Props {
  settings: Record<string, unknown>;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}

export default function FirmwareTimeoutCard({ settings, onSave, saving }: Props) {
  // Only edits are held in state; everything else is read straight from the
  // saved settings. Mirroring props into state with an effect is the obvious
  // shape and the wrong one — it sets state synchronously during render, which
  // risks cascading renders and leaves two sources of truth that can disagree
  // while a save is in flight.
  const [draft, setDraft] = useState<{ download?: string; reboot?: string }>({});
  const savedDownload = String(settings.firmware_download_timeout_min ?? 10);
  const savedReboot = String(settings.firmware_reboot_timeout_min ?? 12);
  const download = draft.download ?? savedDownload;
  const reboot = draft.reboot ?? savedReboot;
  const setDownload = (v: string) => setDraft((d) => ({ ...d, download: v }));
  const setReboot = (v: string) => setDraft((d) => ({ ...d, reboot: v }));

  const clamp = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(MAX, Math.max(MIN, Math.round(n))) : fallback;
  };

  const dirty =
    clamp(download, 10) !== Number(savedDownload) || clamp(reboot, 12) !== Number(savedReboot);

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Clock className="w-4 h-4 text-blue-500" />
        <h3 className="font-semibold text-gray-900 dark:text-white">Firmware rollout timeouts</h3>
      </div>
      <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
        Applied at the start of each rollout, so a change needs no restart and a rollout in
        flight keeps the values it began with.
      </p>

      <div className="grid sm:grid-cols-2 gap-4">
        <label className="text-sm">
          <span className="text-gray-700 dark:text-slate-300">Download timeout</span>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="number" min={MIN} max={MAX} value={download}
              onChange={(e) => setDownload(e.target.value)}
              className="input w-24"
            />
            <span className="text-xs text-gray-400">minutes</span>
          </div>
          <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
            Waiting for the image to land. A device that fails to download is never rebooted,
            so raising this costs a delay rather than a risk.
          </p>
        </label>

        <label className="text-sm">
          <span className="text-gray-700 dark:text-slate-300">Reboot timeout</span>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="number" min={MIN} max={MAX} value={reboot}
              onChange={(e) => setReboot(e.target.value)}
              className="input w-24"
            />
            <span className="text-xs text-gray-400">minutes</span>
          </div>
          <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
            Waiting for the device to come back after the flash. CRS switches have been
            reported needing a full 12 minutes; raise it if your hardware is slower.
          </p>
        </label>
      </div>

      <div className="flex justify-end mt-4">
        <button
          onClick={() => {
            onSave({
              firmware_download_timeout_min: clamp(download, 10),
              firmware_reboot_timeout_min: clamp(reboot, 12),
            });
            // Drop the draft so the fields follow the saved values again,
            // including the server's clamping.
            setDraft({});
          }}
          disabled={!dirty || saving}
          className="btn-primary text-[12px] flex items-center gap-2 disabled:opacity-50"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}
