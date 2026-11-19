import { Point } from '@influxdata/influxdb-client';
import { query } from '../config/database';
import { getWriteApi } from '../config/influxdb';

const EVERY_MS = 15_000;
let writtenAt = 0;

/**
 * The deduplicated client count, fleet-wide (`_global`) and per site
 * (`_site_<id>`, #130), for the clients-over-time chart, which reads it at
 * five-minute resolution. Summing per-device series would count a client seen
 * by two devices twice.
 *
 * Was counted after every device's poll: two COUNT(DISTINCT) scans of the
 * clients table per device per fast poll, so the cost grew with fleet size
 * times client count. Now at most once per 15 s per process, in one query.
 */
export async function writeClientCounts(): Promise<void> {
  if (Date.now() - writtenAt < EVERY_MS) return;
  writtenAt = Date.now();
  try {
    // From devices, so a site whose clients have all gone writes 0, as before.
    const rows = await query<{ site_id: number | null; fleet: boolean; count: string }>(
      `SELECT d.site_id, GROUPING(d.site_id) = 1 AS fleet, COUNT(DISTINCT c.mac_address) AS count
         FROM devices d LEFT JOIN clients c ON c.device_id = d.id AND c.active
        GROUP BY ROLLUP (d.site_id)`
    );
    const writeApi = getWriteApi();
    const now = new Date();
    for (const r of rows) {
      const tag = r.fleet ? '_global' : r.site_id != null ? `_site_${r.site_id}` : null;
      if (!tag) continue;
      writeApi.writePoint(new Point('client_counts').tag('device_id', tag).tag('device_name', tag)
        .intField('total_clients', parseInt(r.count || '0', 10)).timestamp(now));
    }
    await writeApi.flush();
  } catch (err) {
    console.error('[clients] Fleet client count not written:', (err as Error).message);
  }
}
