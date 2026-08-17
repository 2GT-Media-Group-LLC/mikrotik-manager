import { useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck, ShieldAlert, Route } from 'lucide-react';

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

// ─── Predicted-lockout verdict ────────────────────────────────────────────────

export interface VerdictViolation {
  id: string;
  title: string;
  detail: string;
  severity: 'critical' | 'warning';
}

export interface VerdictPath {
  mgmt_interface: string | null;
  bridge: string | null;
  mgmt_vlan_id: number | null;
  tagged_management: boolean;
  ingress_port: string | null;
  ingress_port_source: string;
  hops: Array<{ kind: string; name: string; reason: string }>;
}

export interface LockoutVerdict {
  severity: 'safe' | 'warning' | 'critical';
  headline: string;
  violations: VerdictViolation[];
  warnings: string[];
  path: VerdictPath;
}

/** Pull a 409 lockout verdict off a failed mutation, if the backend sent one. */
export function lockoutVerdictOf(err: unknown): LockoutVerdict | null {
  const r = (err as { response?: { status?: number; data?: { lockout?: boolean; verdict?: LockoutVerdict } } })?.response;
  if (r?.status === 409 && r.data?.lockout && r.data.verdict) return r.data.verdict;
  return null;
}

export interface LockoutVerdictDialogProps {
  verdict: LockoutVerdict;
  /** Typed into the confirm box for a critical verdict — normally the device name. */
  confirmPhrase: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Explains a predicted lockout and, for a critical verdict, makes the user type the
 * device name before overriding. The reason chain is the point: a warning the user
 * can verify is one they'll act on, rather than click past.
 */
export function LockoutVerdictDialog({
  verdict, confirmPhrase, pending = false, onConfirm, onCancel,
}: LockoutVerdictDialogProps) {
  const [typed, setTyped] = useState('');
  const critical = verdict.severity === 'critical';
  const canConfirm = !critical || typed.trim() === confirmPhrase;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 p-6 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start gap-3">
          {critical
            ? <ShieldAlert className="w-6 h-6 text-red-500 flex-shrink-0" />
            : <AlertTriangle className="w-6 h-6 text-amber-500 flex-shrink-0" />}
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">
              {critical ? 'This will disconnect the device' : 'This leaves management fragile'}
            </h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">{verdict.headline}</p>
          </div>
        </div>

        {verdict.violations.map((v) => (
          <div
            key={v.id}
            className={
              v.severity === 'critical'
                ? 'rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-3'
                : 'rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3'
            }
          >
            <p className={`text-xs font-semibold uppercase tracking-wide ${
              v.severity === 'critical'
                ? 'text-red-700 dark:text-red-400'
                : 'text-amber-700 dark:text-amber-400'
            }`}>{v.title}</p>
            <p className={`mt-1 text-sm ${
              v.severity === 'critical'
                ? 'text-red-800 dark:text-red-300'
                : 'text-amber-800 dark:text-amber-300'
            }`}>{v.detail}</p>
          </div>
        ))}

        {verdict.path.hops.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
            <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-gray-500 dark:text-slate-400">
              <Route className="w-3.5 h-3.5" />
              How the manager reaches this device
            </div>
            <ul className="space-y-1.5">
              {verdict.path.hops.map((h, i) => (
                <li key={i} className="text-xs text-gray-600 dark:text-slate-300">
                  <span className="mono text-[11px] text-gray-400 dark:text-slate-500">{h.kind}</span>{' '}
                  <span className="font-medium">{h.name}</span>
                  <div className="text-gray-500 dark:text-slate-400">{h.reason}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {verdict.warnings.length > 0 && (
          <ul className="space-y-1">
            {verdict.warnings.map((w, i) => (
              <li key={i} className="text-xs text-gray-500 dark:text-slate-400">• {w}</li>
            ))}
          </ul>
        )}

        {critical && (
          <div>
            <label className="label">
              Type <span className="mono font-semibold">{confirmPhrase}</span> to apply anyway
            </label>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmPhrase}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
              The change will still run under auto-revert: if the device stops responding, it
              restores itself and comes back.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel} className="btn-secondary" disabled={pending}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={pending || !canConfirm}
            className={`px-4 py-1.5 disabled:opacity-50 text-white text-sm font-medium rounded-lg flex items-center gap-2 ${
              critical ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'
            }`}
          >
            {pending && <RefreshCw className="w-4 h-4 animate-spin" />}
            Apply anyway
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
