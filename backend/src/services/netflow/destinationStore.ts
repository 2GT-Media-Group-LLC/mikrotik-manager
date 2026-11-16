// Writes traffic destinations (#366 step 2) into client_destinations: each
// window's rows added to the hour they fall in, in chunks.

import { query } from '../../config/database';
import type { DestinationRow } from './DestinationAggregator';

const CHUNK = 5_000;

/** The start of the hour `at` falls in. */
export function hourOf(at: Date): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export async function writeDestinations(rows: DestinationRow[], at: Date): Promise<void> {
  const hour = hourOf(at).toISOString();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const col = <T>(f: (r: DestinationRow) => T) => part.map(f);
    await query(
      `INSERT INTO client_destinations (hour, site_id, mac, app, remote, upload_bytes, download_bytes, packets)
       SELECT $1::timestamptz, u.* FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[])
         AS u(site_id, mac, app, remote, upload_bytes, download_bytes, packets)
       ON CONFLICT (hour, site_id, mac, app, remote) DO UPDATE SET
         upload_bytes   = client_destinations.upload_bytes + EXCLUDED.upload_bytes,
         download_bytes = client_destinations.download_bytes + EXCLUDED.download_bytes,
         packets        = client_destinations.packets + EXCLUDED.packets`,
      [hour, col((r) => r.siteId), col((r) => r.clientKey.slice(0, 17)), col((r) => r.app.slice(0, 32)),
        col((r) => r.remote.slice(0, 45)), col((r) => r.uploadBytes), col((r) => r.downloadBytes), col((r) => r.packets)]
    );
  }
}
