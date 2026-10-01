// In-memory flow aggregation between flushes (60s windows).
//
// Counters are kept PER EXPORTER per (client, direction, app) so that a flow
// crossing two managed routers — and therefore exported twice — can be
// deduplicated at drain time: for each client we keep only the exporter that
// saw the most bytes in the window (it converges on the gateway, which sees
// all of a client's traffic) and discard the rest. Tie-break: lowest exporter
// id, for determinism.
//
// A client is identified by its site as well as its key (outside review J4):
// the same MAC, or the 'unknown' bucket, at two sites is two clients, never one.

export type Direction = 'upload' | 'download';

// Pseudo-client keys (not real MACs, but stored in the same mac slot)
export const CLIENT_UNKNOWN = 'unknown';
export const CLIENT_OTHER = 'other';

export interface FlowSample {
  exporterId: number; // managed device id that exported the flow
  siteId: number | null; // site the client was matched in; null if none could be determined
  clientKey: string; // client MAC address, or CLIENT_UNKNOWN
  direction: Direction;
  app: string;
  bytes: number;
  packets: number;
}

export interface AggregatedRow {
  siteId: number | null;
  clientKey: string;
  direction: Direction;
  app: string;
  bytes: number;
  packets: number;
}

interface Bucket {
  exporterId: number;
  siteId: number | null;
  clientKey: string;
  direction: Direction;
  app: string;
  bytes: number;
  packets: number;
}

/** A client within its site. */
const clientId = (b: { siteId: number | null; clientKey: string }): string => `${b.siteId ?? ''}|${b.clientKey}`;

export class FlowAggregator {
  private buckets = new Map<string, Bucket>();

  add(sample: FlowSample): void {
    if (sample.bytes <= 0 && sample.packets <= 0) return;
    const key = `${sample.exporterId}|${clientId(sample)}|${sample.direction}|${sample.app}`;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.bytes += sample.bytes;
      existing.packets += sample.packets;
    } else {
      this.buckets.set(key, { ...sample });
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  // Drain the window: dedup across exporters, then fold clients beyond the
  // top-N (by total bytes) into CLIENT_OTHER to bound series cardinality.
  // Pseudo-clients (unknown) are never folded — they're already aggregates.
  drain(topN: number): AggregatedRow[] {
    const all = Array.from(this.buckets.values());
    this.buckets.clear();
    if (all.length === 0) return [];

    // 1. Pick the winning exporter per client (max bytes, tie → lowest id)
    const totals = new Map<string, Map<number, number>>(); // clientKey → exporterId → bytes
    for (const b of all) {
      let perExporter = totals.get(clientId(b));
      if (!perExporter) {
        perExporter = new Map();
        totals.set(clientId(b), perExporter);
      }
      perExporter.set(b.exporterId, (perExporter.get(b.exporterId) || 0) + b.bytes);
    }
    const winner = new Map<string, number>(); // clientKey → exporterId
    for (const [clientKey, perExporter] of totals) {
      let bestId = -1;
      let bestBytes = -1;
      for (const [exporterId, bytes] of perExporter) {
        if (bytes > bestBytes || (bytes === bestBytes && exporterId < bestId)) {
          bestId = exporterId;
          bestBytes = bytes;
        }
      }
      winner.set(clientKey, bestId);
    }

    // 2. Keep only the winning exporter's rows, merged by (client, dir, app)
    const merged = new Map<string, AggregatedRow>();
    const clientBytes = new Map<string, number>();
    for (const b of all) {
      if (winner.get(clientId(b)) !== b.exporterId) continue;
      const key = `${clientId(b)}|${b.direction}|${b.app}`;
      const row = merged.get(key);
      if (row) {
        row.bytes += b.bytes;
        row.packets += b.packets;
      } else {
        merged.set(key, {
          siteId: b.siteId,
          clientKey: b.clientKey,
          direction: b.direction,
          app: b.app,
          bytes: b.bytes,
          packets: b.packets,
        });
      }
      clientBytes.set(clientId(b), (clientBytes.get(clientId(b)) || 0) + b.bytes);
    }

    // 3. Top-N fold
    const realClients = Array.from(clientBytes.keys()).filter((c) => !c.endsWith(`|${CLIENT_UNKNOWN}`));
    const keep = new Set(
      realClients
        .sort((a, c) => (clientBytes.get(c) || 0) - (clientBytes.get(a) || 0))
        .slice(0, topN)
    );

    const result = new Map<string, AggregatedRow>();
    for (const row of merged.values()) {
      // Folded clients go to their own site's 'other' bucket.
      const clientKey =
        row.clientKey === CLIENT_UNKNOWN || keep.has(clientId(row))
          ? row.clientKey
          : CLIENT_OTHER;
      const key = `${row.siteId ?? ''}|${clientKey}|${row.direction}|${row.app}`;
      const out = result.get(key);
      if (out) {
        out.bytes += row.bytes;
        out.packets += row.packets;
      } else {
        result.set(key, { ...row, clientKey });
      }
    }
    return Array.from(result.values());
  }
}
