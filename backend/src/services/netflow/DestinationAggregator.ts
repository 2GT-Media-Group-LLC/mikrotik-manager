// Where clients' traffic goes (#366 step 2), gathered between flushes.
//
// Fed only flows with one local end and one remote end, keyed by exporter,
// client, application and remote address. A flow that crosses two managed
// routers is exported twice, so at drain time each client keeps only the
// exporter that saw the most of its bytes, as FlowAggregator does for totals.
// Then each client and application keeps its busiest remote addresses; the
// rest are summed under OTHER_REMOTE so a scan or a torrent can't flood the
// table with one row per address.

import type { Direction } from './FlowAggregator';

/** The remote address under which the less busy ones are summed. */
export const OTHER_REMOTE = '';
/** Remote addresses kept per client and application in each window. */
export const DEFAULT_TOP_REMOTES = 20;
/** Bound on distinct keys in one window, so a flood can't grow memory without limit. */
export const MAX_KEYS = 200_000;

export interface DestinationSample {
  exporterId: number;
  siteId: number | null;
  clientKey: string;
  app: string;
  remote: string;
  direction: Direction;
  bytes: number;
  packets: number;
}

export interface DestinationRow {
  siteId: number;
  clientKey: string;
  app: string;
  remote: string;
  uploadBytes: number;
  downloadBytes: number;
  packets: number;
}

interface Bucket {
  exporterId: number;
  siteId: number;
  clientKey: string;
  app: string;
  remote: string;
  up: number;
  down: number;
  packets: number;
}

const clientId = (b: { siteId: number; clientKey: string }) => `${b.siteId}|${b.clientKey}`;

export class DestinationAggregator {
  private buckets = new Map<string, Bucket>();
  private dropped = 0;

  add(s: DestinationSample): void {
    if (s.bytes <= 0 && s.packets <= 0) return;
    const siteId = s.siteId ?? 0;
    const key = `${s.exporterId}|${siteId}|${s.clientKey}|${s.app}|${s.remote}`;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= MAX_KEYS) {
        // Past the bound, a new address joins its client's "other" for this window.
        const otherKey = `${s.exporterId}|${siteId}|${s.clientKey}|${s.app}|${OTHER_REMOTE}`;
        b = this.buckets.get(otherKey);
        if (!b) { this.dropped++; return; }
      } else {
        b = { exporterId: s.exporterId, siteId, clientKey: s.clientKey, app: s.app, remote: s.remote, up: 0, down: 0, packets: 0 };
        this.buckets.set(key, b);
      }
    }
    if (s.direction === 'upload') b.up += s.bytes; else b.down += s.bytes;
    b.packets += s.packets;
  }

  get size(): number { return this.buckets.size; }
  /** Samples lost to the key bound since the last drain. */
  get droppedSamples(): number { return this.dropped; }

  drain(topRemotes = DEFAULT_TOP_REMOTES): DestinationRow[] {
    const all = [...this.buckets.values()];
    this.buckets.clear();
    this.dropped = 0;
    if (all.length === 0) return [];

    // 1. Each client's busiest exporter wins (tie: lowest id), as for totals.
    const perExporter = new Map<string, Map<number, number>>();
    for (const b of all) {
      const m = perExporter.get(clientId(b)) ?? new Map<number, number>();
      m.set(b.exporterId, (m.get(b.exporterId) ?? 0) + b.up + b.down);
      perExporter.set(clientId(b), m);
    }
    const winner = new Map<string, number>();
    for (const [c, m] of perExporter) {
      let best = -Infinity, bestId = 0;
      for (const [id, bytes] of m) if (bytes > best || (bytes === best && id < bestId)) { best = bytes; bestId = id; }
      winner.set(c, bestId);
    }

    // 2. Group the winner's rows by client and application.
    const groups = new Map<string, Bucket[]>();
    for (const b of all) {
      if (winner.get(clientId(b)) !== b.exporterId) continue;
      const g = `${clientId(b)}|${b.app}`;
      const list = groups.get(g) ?? [];
      list.push(b);
      groups.set(g, list);
    }

    // 3. Keep the busiest remotes; sum the rest under OTHER_REMOTE.
    const out: DestinationRow[] = [];
    for (const list of groups.values()) {
      const named = list.filter((b) => b.remote !== OTHER_REMOTE).sort((a, b) => (b.up + b.down) - (a.up + a.down));
      const other = list.find((b) => b.remote === OTHER_REMOTE);
      const keep = named.slice(0, topRemotes);
      const rest = named.slice(topRemotes);
      for (const b of keep) out.push(toRow(b));
      if (rest.length || other) {
        const base = keep[0] ?? rest[0] ?? other!;
        const sum = { ...base, remote: OTHER_REMOTE, up: 0, down: 0, packets: 0 };
        for (const b of [...rest, ...(other ? [other] : [])]) { sum.up += b.up; sum.down += b.down; sum.packets += b.packets; }
        out.push(toRow(sum));
      }
    }
    return out;
  }
}

const toRow = (b: Bucket): DestinationRow => ({
  siteId: b.siteId, clientKey: b.clientKey, app: b.app, remote: b.remote,
  uploadBytes: b.up, downloadBytes: b.down, packets: b.packets,
});
