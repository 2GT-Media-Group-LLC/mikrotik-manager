import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';

/**
 * Confirmation for a change that could sever the manager's path to a device.
 *
 * Follows the existing LockoutDialog/ScanWarningModal pattern (amber = dangerous
 * but intentional; red is reserved for delete), and explains the protection that
 * will be applied so the user knows what happens if it goes wrong.
 */
export interface ChangeGuardDialogProps {
  title: string;
  /** What the user is about to do, in plain language. */
  description: string;
  /** Optional extra risk detail (e.g. why this object matters to reachability). */
  reason?: string;
  confirmLabel: string;
  /** When false, the safety net is unavailable and the change is unprotected. */
  protectedByGuard?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ChangeGuardDialog({
  title, description, reason, confirmLabel,
  protectedByGuard = true, pending = false, onConfirm, onCancel,
}: ChangeGuardDialogProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-6 h-6 text-amber-500 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">{description}</p>
          </div>
        </div>

        {reason && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3">
            <p className="text-sm text-amber-800 dark:text-amber-300">{reason}</p>
          </div>
        )}

        {protectedByGuard ? (
          <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-slate-400">
            <ShieldCheck className="w-4 h-4 flex-shrink-0 text-green-600 dark:text-green-400" />
            <span>
              Protected: the device saves a restore point first. If it stops responding after
              this change, it restores itself automatically and comes back.
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              Auto-revert is not available for this device, so this change cannot be undone
              automatically if it goes wrong.
            </span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel} className="btn-secondary" disabled={pending}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={pending}
            className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg flex items-center gap-2"
          >
            {pending && <RefreshCw className="w-4 h-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shape returned by guarded endpoints so callers can report the outcome. */
export interface GuardResult {
  protected: boolean;
  confirmed: boolean;
  auto_reverting: boolean;
  unprotected_reason: string | null;
}

/** Human-readable outcome for a guarded change, or null when nothing to say. */
export function guardOutcomeMessage(guard?: GuardResult): { tone: 'ok' | 'warn'; text: string } | null {
  if (!guard) return null;
  if (guard.auto_reverting) {
    return {
      tone: 'warn',
      text: 'The device stopped responding after this change, so it is restoring itself to the '
        + 'previous configuration. It should come back shortly — the change was not kept.',
    };
  }
  if (guard.confirmed) {
    return { tone: 'ok', text: 'Applied — device confirmed still reachable.' };
  }
  if (guard.unprotected_reason) {
    return { tone: 'warn', text: `Applied without auto-revert protection: ${guard.unprotected_reason}` };
  }
  return null;
}
