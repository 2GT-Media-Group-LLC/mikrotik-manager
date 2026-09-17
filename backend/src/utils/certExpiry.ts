/**
 * Deciding when a device certificate needs attention.
 *
 * Requested after a real outage: an OpenVPN client certificate expired
 * unnoticed and the device simply stopped connecting. Nothing about that failure
 * announces itself as an expiry — the tunnel is just down.
 *
 * The alerting half of this already existed and had never been wired to
 * anything. `cert_expiry` is a declared event type with a label, an icon, Slack
 * and Discord colours, webhook delivery, and a default rule of "warn 14 days
 * ahead, at most once a day" — all of it inert, because nothing ever read a
 * certificate. A user could enable the rule, set a threshold, and wait for an
 * alert that could not arrive. This supplies the missing half.
 */

export type CertState =
  /**
   * Withdrawn by its issuing CA. Dates say nothing about this: a revoked
   * certificate keeps a perfectly valid invalid-after and read as "Valid" here
   * until a user pointed out we were showing green for certificates he had
   * deliberately killed (#143).
   */
  | 'revoked'
  /** Past its invalid-after date. */
  | 'expired'
  /** Inside the warning window. */
  | 'expiring'
  /** Not yet valid — a clock problem, or a certificate issued for later use. */
  | 'not-yet-valid'
  | 'valid'
  /** No usable expiry date; nothing can be claimed about it. */
  | 'unknown';

export interface CertVerdict {
  state: CertState;
  /** Whole days until expiry; negative once past. Null when unknown. */
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Classify one certificate.
 *
 * `warnDays` comes from the alert rule's threshold, so the operator's setting
 * decides the window rather than a constant buried here.
 */
export function certExpiryState(
  invalidAfter: Date | string | null | undefined,
  now: Date,
  warnDays: number,
  invalidBefore?: Date | string | null,
  opts?: { revoked?: boolean | null },
): CertVerdict {
  const after = toDate(invalidAfter);

  // Checked before the dates, because revocation overrides them entirely. A
  // certificate revoked today may not expire for another year; the year is
  // irrelevant, it stopped being usable the moment it was withdrawn.
  if (opts?.revoked) {
    return { state: 'revoked', daysLeft: after ? daysBetween(after, now) : null };
  }

  if (!after) return { state: 'unknown', daysLeft: null };

  const daysLeft = daysBetween(after, now);

  if (after.getTime() <= now.getTime()) return { state: 'expired', daysLeft };

  const before = toDate(invalidBefore);
  if (before && before.getTime() > now.getTime()) {
    // Worth separating from "valid": a certificate that is not yet usable will
    // fail connections today, and usually means the device clock is wrong.
    return { state: 'not-yet-valid', daysLeft };
  }

  // A threshold of zero or less would otherwise warn about everything.
  const window = Number.isFinite(warnDays) && warnDays > 0 ? warnDays : 0;
  return { state: daysLeft <= window ? 'expiring' : 'valid', daysLeft };
}

/**
 * Whole days from `now` to `after`; negative once past.
 *
 * Truncated towards zero, not floored. Math.floor rounds a negative *away* from
 * zero, so a certificate three days and one hour past its date reported
 * "expired 4 days ago" — observed in real output. Truncation reads the same in
 * both directions: 4.9 days left is "4 days", 3.1 days gone is "3 days".
 */
function daysBetween(after: Date, now: Date): number {
  return Math.trunc((after.getTime() - now.getTime()) / DAY_MS);
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whether a verdict is worth *alerting* someone about.
 *
 * Revocation is deliberately excluded. Someone revoked that certificate on
 * purpose, and several of them cannot be deleted while a CA still references
 * them — so alerting would mean a daily email about a decision the operator
 * already made and cannot undo. It is shown in the list, where it corrects the
 * false "Valid", but it does not page anyone.
 */
export function needsAttention(v: CertVerdict): boolean {
  return v.state === 'expired' || v.state === 'expiring' || v.state === 'not-yet-valid';
}

export interface CertLike {
  name: string;
  common_name?: string | null;
  is_authority?: boolean | null;
  invalid_after?: Date | string | null;
  revoked?: boolean | null;
}

/**
 * The sentence a human reads in an alert.
 *
 * Names the certificate and says what breaks, because "certificate expiring" on
 * its own sends someone hunting through `/certificate print` on every device.
 * A certificate authority is called out separately: it expiring invalidates
 * everything it signed, not just one connection.
 */
export function describeCert(cert: CertLike, v: CertVerdict): string {
  const kind = cert.is_authority ? 'Certificate authority' : 'Certificate';
  const named = cert.common_name && cert.common_name !== cert.name
    ? `${cert.name} (${cert.common_name})`
    : cert.name;

  switch (v.state) {
    case 'revoked':
      return `${kind} ${named} has been revoked`;
    case 'expired':
      return `${kind} ${named} expired ${plural(Math.abs(v.daysLeft ?? 0))} ago`;
    case 'expiring':
      return v.daysLeft === 0
        ? `${kind} ${named} expires today`
        : `${kind} ${named} expires in ${plural(v.daysLeft ?? 0)}`;
    case 'not-yet-valid':
      return `${kind} ${named} is not valid yet — check the device clock`;
    default:
      return `${kind} ${named}`;
  }
}

const plural = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;
