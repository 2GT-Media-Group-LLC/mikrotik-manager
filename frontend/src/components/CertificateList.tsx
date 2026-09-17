import { ShieldCheck, ShieldAlert, ShieldX, Clock, KeyRound } from 'lucide-react';
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
}

export default function CertificateList({ certificates, showDevice, emptyText }: Props) {
  if (certificates.length === 0) {
    return (
      <p className="text-sm text-gray-400 dark:text-slate-500 py-3">
        {emptyText ?? 'No certificates found on this device.'}
      </p>
    );
  }

  return (
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
          {certificates.map((c) => {
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
                      <div className={clsx('text-xs', s.cls)}>{relative(c.days_left)}</div>
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
  );
}
