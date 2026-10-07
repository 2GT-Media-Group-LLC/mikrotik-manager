/**
 * Interface error counters and link flaps (#249).
 *
 * A failing optic or patch cable usually keeps the link up while it corrupts
 * frames, so link state alone misses it. RouterOS counts those frames per
 * Ethernet port (/interface/ethernet/print stats) and counts link drops per
 * interface (link-downs). These are cumulative since boot; what matters is how
 * fast they grow, so each poll is turned into a delta and only intervals in
 * which something grew are kept. Pure, so it can be tested without a device.
 *
 * Not every model reports every counter (the wAP ax has no rx-overflow on some
 * releases, CRS3xx has no rx-align-error); a missing counter is simply absent.
 */

export type ErrorKind = 'fcs' | 'align' | 'overflow' | 'other';

/** RouterOS counter names, grouped the way they're reported. */
export const ERROR_COUNTERS: Record<ErrorKind, string[]> = {
  fcs: ['rx-fcs-error'],
  align: ['rx-align-error'],
  // Frames dropped because the port's receive buffer was full: congestion
  // rather than a bad link, but asked for alongside the others.
  overflow: ['rx-overflow'],
  // Other signs of a bad physical link or a duplex mismatch. rx-too-long is
  // left out: oversized frames are an MTU mismatch, not a failing cable.
  other: ['rx-fragment', 'rx-jabber', 'rx-code-error', 'rx-carrier-error', 'rx-too-short', 'tx-late-collision'],
};

const KINDS = Object.keys(ERROR_COUNTERS) as ErrorKind[];

export interface PortCounters {
  /** Summed per kind. */
  errors: Record<ErrorKind, number>;
  linkDowns: number | null;
}

export interface PortDelta {
  errors: Record<ErrorKind, number>;
  linkDowns: number;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const n = Number(v.replace(/\s/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Sum one Ethernet stats row into the four kinds, plus link-downs from /interface. */
export function readCounters(eth: Record<string, string>, linkDowns: string | undefined): PortCounters {
  const errors = { fcs: 0, align: 0, overflow: 0, other: 0 } as Record<ErrorKind, number>;
  for (const kind of KINDS) {
    for (const key of ERROR_COUNTERS[kind]) errors[kind] += num(eth[key]) ?? 0;
  }
  return { errors, linkDowns: num(linkDowns) };
}

/**
 * How much each counter grew. Null when any went backwards: the device
 * rebooted or the counters were reset, and the new values become the baseline
 * without counting anything.
 */
export function counterDelta(prev: PortCounters, cur: PortCounters): PortDelta | null {
  const errors = { fcs: 0, align: 0, overflow: 0, other: 0 } as Record<ErrorKind, number>;
  for (const kind of KINDS) {
    const d = cur.errors[kind] - prev.errors[kind];
    if (d < 0) return null;
    errors[kind] = d;
  }
  let linkDowns = 0;
  if (cur.linkDowns !== null && prev.linkDowns !== null) {
    if (cur.linkDowns < prev.linkDowns) return null;
    linkDowns = cur.linkDowns - prev.linkDowns;
  }
  return { errors, linkDowns };
}

export const totalErrors = (e: Record<ErrorKind, number>): number => KINDS.reduce((s, k) => s + (e[k] || 0), 0);

export function isEmpty(d: PortDelta): boolean {
  return d.linkDowns === 0 && totalErrors(d.errors) === 0;
}

/** One stored interval: what grew, and when it was seen. */
export interface ErrorEvent {
  interface: string;
  /** Seconds before now. */
  ago_sec: number;
  fcs: number;
  align: number;
  overflow: number;
  other: number;
  link_downs: number;
}

export const RATE_WINDOW_MIN = 5;
export const RECENT_WINDOW_MIN = 15;
export const DEFAULT_ERRORS_PER_MIN = 10;
export const DEFAULT_FLAPS_PER_HOUR = 3;

export interface PortErrorSummary {
  interface: string;
  /** Totals over the last hour. */
  hour: Record<ErrorKind, number> & { link_downs: number };
  /** Errors per minute, averaged over the last RATE_WINDOW_MIN minutes. */
  rate_per_min: number;
  /** Seconds since errors last grew; null when not in the last hour. */
  last_error_ago_sec: number | null;
  /**
   * 'alert': over the error-rate threshold, or flapping past the flap
   * threshold. 'errors': errors in the last RECENT_WINDOW_MIN minutes, below
   * the threshold. null: quiet.
   */
  state: 'alert' | 'errors' | null;
  flapping: boolean;
}

/** Per-port summary of the last hour of events. */
export function summarise(
  events: ErrorEvent[], errorsPerMin = DEFAULT_ERRORS_PER_MIN, flapsPerHour = DEFAULT_FLAPS_PER_HOUR,
): PortErrorSummary[] {
  const byPort = new Map<string, ErrorEvent[]>();
  for (const e of events) {
    if (e.ago_sec > 3600) continue;
    const list = byPort.get(e.interface) ?? [];
    list.push(e);
    byPort.set(e.interface, list);
  }
  const out: PortErrorSummary[] = [];
  for (const [name, list] of byPort) {
    const hour = { fcs: 0, align: 0, overflow: 0, other: 0, link_downs: 0 };
    let windowErrors = 0;
    let lastErr: number | null = null;
    let recentErrors = 0;
    for (const raw of list) {
      // Numbers, whatever the driver handed back (BIGINT arrives as a string).
      const e = {
        ...raw, fcs: Number(raw.fcs) || 0, align: Number(raw.align) || 0,
        overflow: Number(raw.overflow) || 0, other: Number(raw.other) || 0, link_downs: Number(raw.link_downs) || 0,
      };
      const errs = e.fcs + e.align + e.overflow + e.other;
      hour.fcs += e.fcs; hour.align += e.align; hour.overflow += e.overflow; hour.other += e.other;
      hour.link_downs += e.link_downs;
      if (errs > 0) {
        if (e.ago_sec <= RATE_WINDOW_MIN * 60) windowErrors += errs;
        if (e.ago_sec <= RECENT_WINDOW_MIN * 60) recentErrors += errs;
        lastErr = lastErr === null ? e.ago_sec : Math.min(lastErr, e.ago_sec);
      }
    }
    const rate = Math.round((windowErrors / RATE_WINDOW_MIN) * 10) / 10;
    const flapping = hour.link_downs >= Math.max(1, flapsPerHour);
    const overRate = rate >= Math.max(1, errorsPerMin);
    out.push({
      interface: name,
      hour,
      rate_per_min: rate,
      last_error_ago_sec: lastErr,
      state: overRate || flapping ? 'alert' : recentErrors > 0 ? 'errors' : null,
      flapping,
    });
  }
  return out.sort((a, b) => a.interface.localeCompare(b.interface, undefined, { numeric: true }));
}

/** "FCS 40, alignment 2" — only the kinds that grew. */
export function describeErrors(e: Partial<Record<ErrorKind, number>>): string {
  const labels: Record<ErrorKind, string> = { fcs: 'FCS', align: 'alignment', overflow: 'overflow', other: 'other' };
  return KINDS.filter((k) => (e[k] ?? 0) > 0).map((k) => `${labels[k]} ${e[k]}`).join(', ');
}
