/**
 * Daily data-cap tracking for cellular links, and when to trigger the SMS that
 * lifts an operator's throttle.
 *
 * Several European carriers sell "unlimited" mobile data that is throttled hard
 * once a daily allowance is used, and lift the throttle when the subscriber
 * texts a short code. The counter that matters lives on the carrier's side and
 * resets at local midnight; ours is a reconstruction, and the gap between the
 * two is what this module has to be honest about.
 *
 * **Our figure is always an undercount.** Interface byte counters do not survive
 * a reboot — confirmed on the hardware this was built for — so anything used
 * before the device was adopted, during a reboot, or between a missed poll and
 * the next one is invisible to us. Undercounting means triggering *late*, and
 * late means the user is already throttled. So thresholds are meant to be set
 * below the real allowance, and the default margin below does that for them.
 *
 * The saving grace is that the carrier resets daily too, so the error cannot
 * accumulate past one period.
 */

/** Percentage of the configured threshold at which we actually fire. */
export const DEFAULT_SAFETY_MARGIN_PCT = 5;

export interface CounterSample {
  rxBytes: number;
  txBytes: number;
}

/**
 * Bytes used since the previous sample.
 *
 * A counter that has gone *backwards* means the device rebooted and zeroed it.
 * The correct reading then is the new counter itself — everything before the
 * reboot is unrecoverable, and treating the drop as negative usage would corrupt
 * the running total for the rest of the day.
 */
export function bytesSince(prev: CounterSample | null, cur: CounterSample): number {
  const safe = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);
  const rx = safe(cur.rxBytes);
  const tx = safe(cur.txBytes);
  if (!prev) return 0;                       // first sight establishes a baseline only
  const dRx = rx < safe(prev.rxBytes) ? rx : rx - safe(prev.rxBytes);
  const dTx = tx < safe(prev.txBytes) ? tx : tx - safe(prev.txBytes);
  return dRx + dTx;
}

/**
 * Which accounting period an instant falls in, as a local date string.
 *
 * Comparing period keys is how a reset is detected, and it sidesteps converting
 * a local wall-clock time back into UTC — which is where naive implementations
 * get daylight saving wrong. Before the reset hour, the instant still belongs to
 * the previous day's period.
 */
export function periodKey(now: Date, resetHour: number, resetMinute: number, timeZone: string): string {
  let y: number, m: number, d: number, hh: number, mm: number;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).formatToParts(now).map((p) => [p.type, p.value])
    );
    y = Number(parts.year); m = Number(parts.month); d = Number(parts.day);
    hh = Number(parts.hour) % 24; mm = Number(parts.minute);
  } catch {
    y = now.getUTCFullYear(); m = now.getUTCMonth() + 1; d = now.getUTCDate();
    hh = now.getUTCHours(); mm = now.getUTCMinutes();
  }

  // Before the reset time, we are still in yesterday's period.
  if (hh * 60 + mm < resetHour * 60 + resetMinute) {
    const shifted = new Date(Date.UTC(y, m - 1, d));
    shifted.setUTCDate(shifted.getUTCDate() - 1);
    y = shifted.getUTCFullYear(); m = shifted.getUTCMonth() + 1; d = shifted.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Bytes at which we actually fire, given a configured allowance. */
export function effectiveThreshold(thresholdBytes: number, marginPct = DEFAULT_SAFETY_MARGIN_PCT): number {
  const pct = Math.min(50, Math.max(0, marginPct));
  return Math.max(0, Math.floor(thresholdBytes * (1 - pct / 100)));
}

export interface TriggerState {
  periodBytes: number;
  thresholdBytes: number;
  marginPct?: number;
  lastSentAt: Date | null;
  cooldownMinutes: number;
  enabled: boolean;
}

export interface TriggerDecision {
  send: boolean;
  reason: 'below-threshold' | 'cooling-down' | 'disabled' | 'threshold-reached';
}

/**
 * Should an automatic SMS go out right now?
 *
 * The cooldown exists because usage sits *at* the cap once reached, not above
 * it — without one, a link parked on its limit would text the carrier on every
 * poll. Sending twice is a nuisance; sending forty times is an incident.
 */
export function shouldSend(state: TriggerState, now: Date): TriggerDecision {
  if (!state.enabled) return { send: false, reason: 'disabled' };
  if (state.periodBytes < effectiveThreshold(state.thresholdBytes, state.marginPct)) {
    return { send: false, reason: 'below-threshold' };
  }
  if (state.lastSentAt) {
    const elapsedMin = (now.getTime() - state.lastSentAt.getTime()) / 60_000;
    if (elapsedMin < state.cooldownMinutes) return { send: false, reason: 'cooling-down' };
  }
  return { send: true, reason: 'threshold-reached' };
}
