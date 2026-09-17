import { useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, ShieldOff, Clock, KeyRound } from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';
import type { DeviceCertificate, CertState } from '../services/api';

/**
 * Renders collected device certificates (#143).
 *
 * The state and the wording come from the server, which derives them with the
 * same function and threshold that produce the alerts. Recomputing them here
 * would give a page that disagrees with the email sent about the same
 * certificate the first time the rule changed.
 */

const STYLE: Record<CertState, { cls: string; Icon: typeof ShieldCheck; label: string }> = {
  revoked:         { cls: 'text-red-600 dark:text-red-400',       Icon: ShieldOff,   label: 'Revoked' },
  expired:         { cls: 'text-red-600 dark:text-red-400',       Icon: ShieldX,     label: 'Expired' },
  expiring:        { cls: 'text-amber-600 dark:text-amber-400',   Icon: ShieldAlert, label: 'Expiring' },
  'not-yet-valid': { cls: 'text-amber-600 dark:text-amber-400',   Icon: Clock,       label: 'Not yet valid' },
  valid:           { cls: 'text-green-600 dark:text-green-400',   Icon: ShieldCheck, label: 'Valid' },
  unknown:         { cls: 'text-gray-400 dark:text-slate-500',    Icon: ShieldAlert, label: 'Unknown' },
};

/** "in 12 days" / "3 days ago" — the number people actually act on. */
function relative(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'today';
  const n = Math.abs(days);
  const unit = `${n} day${n === 1 ? '' : 's'}`;
  return days > 0 ? `in ${unit}` : `${unit} ago`;
}

interface Props {
  certificates: DeviceCertificate[];
  /** Show which device each belongs to; off on a single-device view. */
  showDevice?: boolean;
  emptyText?: string;
  /**
   * Distinguishes the two places this renders, so the device page and the fleet
   * page each remember the toggle separately.
   */
  storageKey?: string;
}

/**
 * Hiding expired certificates, and why it is a toggle rather than the default.
 *
 * Asked for by a user with an expired certificate he cannot remove: RouterOS
 * refuses to delete it while a CA still references it through a CRL, so it sits
 * in the list permanently reading red with nothing he can do about it (#143).
 *
 * Suppressing expired certificates outright was the other option and is the
 * wrong one — an expired certificate is the exact thing this feature was built
 * to surface, and a fleet-wide default of "don't show the broken ones" would
 * quietly undo it for everyone else. So: shown by default, hidden on request,
 * the choice remembered, and the count still visible while they are hidden so
 * nobody forgets what they filtered out.
 */
function useHideExpired(storageKey: string): [boolean, (v: boolean) => void] {
  const key = `certs.hideExpired.${storageKey}`;
  const [hide, setHide] = useState(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  return [hide, (v: boolean) => {
    setHide(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private mode */ }
  }];
}

export default function CertificateList({
  certificates, showDevice, emptyText, storageKey = 'default',
}: Props) {
  const [hideExpired, setHideExpired] = useHideExpired(storageKey);

  const expiredCount = useMemo(
    () => certificates.filter((c) => c.state === 'expired').length,
    [certificates]
  );
  const visible = useMemo(
    () => (hideExpired ? certificates.filter((c) => c.state !== 'expired') : certificates),
    [certificates, hideExpired]
  );

  if (certificates.length === 0) {
    return (
      <p className="text-sm text-gray-400 dark:text-slate-500 py-3">
        {emptyText ?? 'No certificates found on this device.'}
      </p>
    );
  }

  return (
    <div>
      {/* Only offered when there is something to hide — a permanent control for
          a situation most fleets never hit is just clutter. */}
      {expiredCount > 0 && (
        <div className="flex items-center justify-end pb-2">
          <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideExpired}
              onChange={(e) => setHideExpired(e.target.checked)}
              className="rounded border-gray-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
            />
            Hide expired ({expiredCount})
          </label>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-slate-500 py-3">
          All {expiredCount} certificate{expiredCount === 1 ? ' is' : 's are'} expired and hidden.
        </p>
      ) : (
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
            {showDevice && <th className="px-3 py-2 font-medium">Device</th>}
            <th className="px-3 py-2 font-medium">Certificate</th>
            <th className="px-3 py-2 font-medium">Expires</th>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => {
            const s = STYLE[c.state] ?? STYLE.unknown;
            return (
              <tr
                key={`${c.device_id}-${c.name}`}
                className="border-b border-gray-100 dark:border-slate-800 last:border-0"
              >
                {showDevice && (
                  <td className="px-3 py-2 text-gray-900 dark:text-white whitespace-nowrap">
                    {c.device_name}
                  </td>
                )}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-gray-900 dark:text-white">{c.name}</span>
                    {c.is_authority && (
                      // A CA expiring invalidates everything it signed, so it is
                      // worth distinguishing at a glance.
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                        title="Certificate authority — its expiry invalidates everything it signed"
                      >
                        CA
                      </span>
                    )}
                    {c.has_private_key && (
                      <KeyRound className="w-3 h-3 text-gray-400" aria-label="Has private key" />
                    )}
                    {c.revoked && (
                      // The expiry date on a revoked certificate is meaningless
                      // but still rendered, so say why it does not count.
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                        title="Withdrawn by its issuing CA — no longer usable regardless of its expiry date"
                      >
                        REVOKED
                      </span>
                    )}
                  </div>
                  {c.common_name && c.common_name !== c.name && (
                    <div className="text-xs text-gray-500 dark:text-slate-400">{c.common_name}</div>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {c.invalid_after ? (
                    <>
                      <div className="text-gray-900 dark:text-white">
                        {format(new Date(c.invalid_after), 'd MMM yyyy')}
                      </div>
                      {c.revoked ? (
                        // "expires in 11 months" is true and completely
                        // irrelevant once a certificate has been withdrawn, so
                        // the date it was withdrawn takes that line instead.
                        <div className={clsx('text-xs', s.cls)}>
                          {c.revoked_at
                            ? `revoked ${format(new Date(c.revoked_at), 'd MMM yyyy')}`
                            : 'revoked'}
                        </div>
                      ) : (
                        <div className={clsx('text-xs', s.cls)}>{relative(c.days_left)}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500 dark:text-slate-400 whitespace-nowrap">
                  {c.key_type ? `${c.key_type.toUpperCase()}${c.key_size ? ` ${c.key_size}` : ''}` : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className={clsx('inline-flex items-center gap-1 font-medium', s.cls)}>
                    <s.Icon className="w-3.5 h-3.5" />
                    {s.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      )}

      {hideExpired && visible.length > 0 && (
        <p className="text-xs text-gray-400 dark:text-slate-500 pt-2">
          {expiredCount} expired certificate{expiredCount === 1 ? '' : 's'} hidden.
        </p>
      )}
    </div>
  );
}
