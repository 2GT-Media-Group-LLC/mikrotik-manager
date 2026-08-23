/**
 * LTE modem telemetry: parsing, quality interpretation and change detection.
 *
 * Everything here is calibrated against a real field capture from a MikroTik
 * ATL 18 (Quectel EG18-EA, Cat-18) — see `__tests__/fixtures/lte-atl18.md`.
 * That capture matters because **what an LTE interface reports depends on the
 * modem chipset, not on RouterOS**: the documented `access-technology` arrives
 * as `data-class`, the documented `uicc` as `iccid`, and `registration-status`,
 * `pin-status`, `functionality` and `lac`/`tac` are simply absent. Any field
 * read here is therefore optional, always.
 *
 * Two shapes need real parsing rather than a cast:
 *
 * **Units live inside values.** `rsrp: -97dBm`, `rsrq: -9dB`, `sinr: 17dB` —
 * the suffix is part of the string, and differs per field.
 *
 * **Band information is a composite string**, not a structured record:
 * `primary-band: B1@20Mhz earfcn: 500 phy-cellid: 190`. Band, bandwidth, EARFCN
 * and physical cell id all have to be pulled out of one value.
 *
 * Carrier aggregation is the subtle one. A Cat-18 modem aggregates several
 * carriers and reports one `ca-band` per carrier, so CA is inherently
 * multi-valued while an API sentence parsed into a plain object is not. Both
 * shapes are accepted here — repeated keys surfaced by the client, and several
 * carriers concatenated into a single value — because under-reporting
 * aggregation would misrepresent the link exactly when it is performing best.
 */

/** One aggregated carrier, parsed out of a `primary-band` / `ca-band` value. */
export interface LteBandInfo {
  /** E-UTRA band number, e.g. 1 for `B1@20Mhz`. */
  band: number;
  /** Channel bandwidth in MHz, when reported. */
  bandwidthMhz: number | null;
  /** E-UTRA absolute radio frequency channel number. */
  earfcn: number | null;
  /** Physical cell identity of this carrier. */
  phyCellId: number | null;
  /** The value as the modem wrote it, for display and for debugging. */
  raw: string;
}

export type SignalQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export interface LteStatus {
  status: string | null;
  /** Radio access technology — `data-class` on this modem family. */
  dataClass: string | null;
  modemModel: string | null;
  modemRevision: string | null;
  operator: string | null;
  cellId: string | null;
  enbId: string | null;
  sectorId: string | null;
  phyCellId: string | null;
  sessionUptimeSeconds: number | null;
  primaryBand: LteBandInfo | null;
  caBands: LteBandInfo[];
  rssi: number | null;
  rsrp: number | null;
  rsrq: number | null;
  sinr: number | null;
  cqi: number | null;
  /** Rank indicator — spatial streams currently in use. */
  ri: number | null;
  mcs: number | null;
  dlModulation: string | null;
}

/** Reserved key under which the API client surfaces repeated attributes. */
export const REPEATED_KEY = '.repeated';

// ─── Scalars ──────────────────────────────────────────────────────────────────

/**
 * Read a signal figure whose unit is glued to the number (`-97dBm`, `17dB`).
 *
 * Deliberately strict about what counts as a reading. A modem that has not
 * registered reports blanks, dashes or `unknown` rather than omitting the key,
 * and treating those as 0 would draw a client sitting at 0 dBm — a signal
 * stronger than any transmitter produces.
 */
export function parseSignalValue(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:dBm|dB)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Read a plain integer field, rejecting the blanks an idle modem reports. */
export function parseIntField(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^-?\d+$/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * RouterOS duration to seconds.
 *
 * Two forms are accepted. The API returns the compact `3d7h17m59s`, but the same
 * value renders as a `00:02:51` clock in WinBox, and a field that reads one way
 * in the GUI and another over the wire is not worth betting a blank display on.
 */
export function parseDurationSeconds(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();

  const clock = s.match(/^(\d+):([0-5]\d):([0-5]\d)$/);
  if (clock) {
    return parseInt(clock[1], 10) * 3600 + parseInt(clock[2], 10) * 60 + parseInt(clock[3], 10);
  }

  if (!/^(\d+[wdhms])+$/.test(s)) return null;
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([wdhms])/g)) total += parseInt(n, 10) * units[u];
  return total;
}

/** Allowed-band list as configured on the interface: `band=1,3,7`. */
export function parseBandList(raw: string | undefined | null): number[] {
  if (raw == null) return [];
  return String(raw)
    .split(',')
    .map(p => parseInt(p.trim().replace(/^[bB]/, ''), 10))
    .filter(n => Number.isFinite(n) && n > 0);
}

/** Render a band list back into the form RouterOS expects. */
export function formatBandList(bands: number[]): string {
  return [...new Set(bands)].sort((a, b) => a - b).join(',');
}

// ─── Bands ────────────────────────────────────────────────────────────────────

/**
 * Parse one carrier out of `B1@20Mhz earfcn: 500 phy-cellid: 190`.
 *
 * Bandwidth, EARFCN and cell id are all optional: the band number is the only
 * part every modem reports, so a value of bare `B7` still yields a carrier.
 */
export function parseBandSpec(raw: string | undefined | null): LteBandInfo | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const band = text.match(/\bB(\d+)\b/i);
  if (!band) return null;

  const bandwidth = text.match(/@\s*([\d.]+)\s*mhz/i);
  const earfcn = text.match(/earfcn:?\s*(\d+)/i);
  const phy = text.match(/phy-cellid:?\s*(\d+)/i);

  return {
    band: parseInt(band[1], 10),
    bandwidthMhz: bandwidth ? parseFloat(bandwidth[1]) : null,
    earfcn: earfcn ? parseInt(earfcn[1], 10) : null,
    phyCellId: phy ? parseInt(phy[1], 10) : null,
    raw: text,
  };
}

/**
 * Collect every carrier reported under one key.
 *
 * A Cat-18 modem aggregating three carriers reports three `ca-band` values, but
 * an API sentence flattened into an object holds one value per key. Two shapes
 * therefore have to be handled: the repeated attributes the client preserves
 * under {@link REPEATED_KEY}, and several carriers concatenated into a single
 * value. Splitting before each `B<n>@` recovers the second case without
 * disturbing the first.
 */
export function parseBandSpecs(
  row: Record<string, string>,
  key: string,
): LteBandInfo[] {
  const values: string[] = [];

  const repeatedRaw = row[REPEATED_KEY];
  if (repeatedRaw) {
    try {
      const repeated = JSON.parse(repeatedRaw) as Record<string, string[]>;
      if (Array.isArray(repeated?.[key])) values.push(...repeated[key]);
    } catch {
      // A malformed side-channel must never cost us the primary value below.
    }
  }
  if (values.length === 0 && row[key] != null) values.push(row[key]);

  const out: LteBandInfo[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    // `B1@20Mhz earfcn: 500 B3@20Mhz earfcn: 1800` → one entry per carrier.
    for (const part of String(value).split(/\s*(?=B\d+@)/)) {
      const parsed = parseBandSpec(part);
      if (!parsed) continue;
      const dedupe = `${parsed.band}:${parsed.earfcn ?? ''}:${parsed.phyCellId ?? ''}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(parsed);
    }
  }
  return out;
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

/** Parse a `/interface/lte/monitor` reply. Every field is treated as optional. */
export function parseLteMonitor(row: Record<string, string>): LteStatus {
  const caBands = parseBandSpecs(row, 'ca-band');
  const primary = parseBandSpecs(row, 'primary-band');

  return {
    status: row['status'] || null,
    // `data-class` on Quectel-based modems; `access-technology` is the
    // documented name and appears on others. Accept either.
    dataClass: row['data-class'] || row['access-technology'] || null,
    modemModel: row['model'] || null,
    modemRevision: row['revision'] || null,
    operator: row['current-operator'] || row['operator-name'] || null,
    cellId: row['current-cellid'] || null,
    enbId: row['enb-id'] || null,
    sectorId: row['sector-id'] || null,
    phyCellId: row['phy-cellid'] || null,
    sessionUptimeSeconds: parseDurationSeconds(row['session-uptime']),
    primaryBand: primary[0] ?? null,
    caBands,
    rssi: parseSignalValue(row['rssi']),
    rsrp: parseSignalValue(row['rsrp']),
    rsrq: parseSignalValue(row['rsrq']),
    sinr: parseSignalValue(row['sinr']),
    cqi: parseIntField(row['cqi']),
    ri: parseIntField(row['ri']),
    mcs: parseIntField(row['mcs']),
    dlModulation: row['dl-modulation'] || null,
  };
}

/** Is the modem attached and carrying traffic? */
export function isConnected(status: LteStatus): boolean {
  const s = (status.status || '').toLowerCase();
  // `running` on this modem family, `connected` on others.
  return s === 'running' || s === 'connected';
}

// ─── Quality interpretation ───────────────────────────────────────────────────

/**
 * Signal thresholds. These are the widely used 3GPP-derived operating bands, and
 * the whole point of carrying them: `-97 dBm` tells a user nothing, while "fair"
 * alongside it tells them where they stand.
 */
export function classifyRsrp(rsrp: number | null): SignalQuality {
  if (rsrp == null) return 'unknown';
  if (rsrp >= -80) return 'excellent';
  if (rsrp >= -90) return 'good';
  if (rsrp >= -100) return 'fair';
  return 'poor';
}

export function classifyRsrq(rsrq: number | null): SignalQuality {
  if (rsrq == null) return 'unknown';
  if (rsrq >= -10) return 'excellent';
  if (rsrq >= -15) return 'good';
  if (rsrq >= -20) return 'fair';
  return 'poor';
}

export function classifySinr(sinr: number | null): SignalQuality {
  if (sinr == null) return 'unknown';
  if (sinr >= 20) return 'excellent';
  if (sinr >= 13) return 'good';
  if (sinr >= 0) return 'fair';
  return 'poor';
}

const QUALITY_RANK: Record<Exclude<SignalQuality, 'unknown'>, number> = {
  poor: 0, fair: 1, good: 2, excellent: 3,
};

/**
 * Overall link quality.
 *
 * Deliberately **not** RSRP alone. The field capture that shaped this module
 * showed RSRP −97 dBm — "fair" — on a link running 256QAM at CQI 15 with two
 * spatial streams, which is the modem at its ceiling. RSRP measures how loud the
 * tower is; SINR measures whether the signal is usable, and it is the better
 * predictor of throughput. So SINR leads, RSRP moderates, and a modem reporting
 * neither stays honest about not knowing.
 */
export function overallQuality(status: LteStatus): SignalQuality {
  const sinr = classifySinr(status.sinr);
  const rsrp = classifyRsrp(status.rsrp);
  if (sinr === 'unknown') return rsrp;
  if (rsrp === 'unknown') return sinr;
  // SINR sets the grade; a quiet cell pulls it down but only one step, so a
  // clean link at −97 dBm reads "good" while a clean link at −112 reads "fair".
  const rank = Math.min(QUALITY_RANK[sinr], QUALITY_RANK[rsrp] + 1);
  return (Object.keys(QUALITY_RANK) as Exclude<SignalQuality, 'unknown'>[])
    .find(k => QUALITY_RANK[k] === rank) ?? 'unknown';
}

/** Plain-language reading of the link, for users who don't speak dBm. */
export function describeQuality(status: LteStatus): string {
  if (!isConnected(status)) return 'Not connected';
  const q = overallQuality(status);
  const carriers = status.caBands.length;
  const agg = carriers > 0
    ? ` Aggregating ${carriers + 1} carriers.`
    : '';
  switch (q) {
    case 'excellent':
      return `Excellent — the modem is operating near its ceiling.${agg}`;
    case 'good':
      return `Good — full throughput expected under normal load.${agg}`;
    case 'fair':
      return `Fair — usable, but expect degradation at peak hours.${agg}`;
    case 'poor':
      return `Poor — throughput and stability are likely affected.${agg}`;
    default:
      return `Connected. The modem does not report enough detail to judge quality.${agg}`;
  }
}

// ─── Change detection ─────────────────────────────────────────────────────────

export type LteChangeKind = 'session-reset' | 'handover' | 'band-change';

export interface LteChange {
  kind: LteChangeKind;
  detail: string;
}

/**
 * Compare consecutive polls to recover what happened between them.
 *
 * Scanning is not a usable substitute: it costs service to run, and at the site
 * that prompted this work it returns nothing because there is only one base
 * station within reach. Polling is the vantage point that always exists.
 * Two signals carry most of the story: `session-uptime` running *backwards*
 * means the modem re-registered, and a changed cell id means it handed over.
 */
export function detectChanges(prev: LteStatus | null, next: LteStatus): LteChange[] {
  if (!prev) return [];
  const changes: LteChange[] = [];

  const before = prev.sessionUptimeSeconds;
  const after = next.sessionUptimeSeconds;
  if (before != null && after != null && after < before) {
    changes.push({
      kind: 'session-reset',
      detail: `Session restarted — uptime fell from ${before}s to ${after}s`,
    });
  }

  if (prev.cellId && next.cellId && prev.cellId !== next.cellId) {
    changes.push({
      kind: 'handover',
      detail: `Cell changed from ${prev.cellId} to ${next.cellId}`,
    });
  }

  const bandsOf = (s: LteStatus) =>
    [s.primaryBand, ...s.caBands].filter(Boolean).map(b => b!.band).sort((a, b) => a - b).join(',');
  const bandsBefore = bandsOf(prev);
  const bandsAfter = bandsOf(next);
  if (bandsBefore && bandsAfter && bandsBefore !== bandsAfter) {
    changes.push({
      kind: 'band-change',
      detail: `Bands changed from ${bandsBefore} to ${bandsAfter}`,
    });
  }

  return changes;
}

/**
 * Bands seen serving this device, for warning before a band lock.
 *
 * Scanning is not a dependable answer to "is band N available here?". It costs
 * service to run, is not offered by every modem, and comes back empty in exactly
 * the deployments that most need the warning — the field report behind this code
 * is a fixed antenna 10 km from its only base station, where a scan finds nothing
 * because there is nothing else to find.
 *
 * History answers it passively instead: a band the modem has actually used at
 * this location demonstrably works there, and locking to one never once observed
 * is the shape of a change that strands a device on a mast.
 */
export function observedBands(statuses: LteStatus[]): number[] {
  const seen = new Set<number>();
  for (const s of statuses) {
    if (s.primaryBand) seen.add(s.primaryBand.band);
    for (const c of s.caBands) seen.add(c.band);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The carriers alone, so callers reading stored band data need no full status. */
export type CarrierSet = Pick<LteStatus, 'primaryBand' | 'caBands'>;

/** Aggregate spectrum in use: the primary carrier plus every aggregated one. */
export function totalBandwidthMhz(status: CarrierSet): number {
  return [status.primaryBand, ...status.caBands]
    .filter(Boolean)
    .reduce((mhz, c) => mhz + (c!.bandwidthMhz ?? 0), 0);
}

export interface UplinkAnchor {
  /** Bandwidth of the carrier the uplink actually rides on. */
  primaryMhz: number;
  primaryBand: number;
  /** The widest carrier being aggregated for downlink. */
  widestMhz: number;
  widestBand: number;
}

/**
 * Is the uplink pinned to a narrower carrier than the downlink is using?
 *
 * Left to itself a modem anchors to whichever band it hears best, then aggregates
 * the rest for downlink. That optimises the wrong thing when the loudest band is
 * also the narrowest: uplink rides the primary carrier alone, so a 10 MHz anchor
 * caps upload however much downlink is stacked on top of it. Operators hit this
 * and fix it by excluding the narrow bands, which is the actual reason to lock
 * bands — not coverage.
 *
 * Returns the comparison only when a wider carrier is genuinely being aggregated,
 * so a link that is already anchored to its widest carrier says nothing.
 */
export function uplinkAnchor(status: CarrierSet): UplinkAnchor | null {
  const primary = status.primaryBand;
  if (!primary?.bandwidthMhz) return null;

  let widest = primary;
  for (const c of status.caBands) {
    if ((c.bandwidthMhz ?? 0) > (widest.bandwidthMhz ?? 0)) widest = c;
  }
  if (widest === primary) return null;

  return {
    primaryMhz: primary.bandwidthMhz,
    primaryBand: primary.band,
    widestMhz: widest.bandwidthMhz!,
    widestBand: widest.band,
  };
}

/**
 * Which of the bands about to be locked have never been seen serving this device?
 * An empty result means the lock is supported by evidence.
 */
export function unprovenBands(requested: number[], observed: number[]): number[] {
  const known = new Set(observed);
  return [...new Set(requested)].filter(b => !known.has(b)).sort((a, b) => a - b);
}
