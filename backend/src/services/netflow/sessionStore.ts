// Writes sessions from the tracker to netflow_sessions (#415 step 2): new ones
// in one multi-row insert, later pieces of a long connection as one update.

import { query } from '../../config/database';
import type { SessionRecord } from './sessions';

export interface StoredSession {
  rec: SessionRecord;
  deviceId: number | null;
  clientMac: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Insert new sessions and add continuations to their rows. Returns the new rows' ids, in order. */
export async function writeSessions(items: StoredSession[]): Promise<Array<number | undefined>> {
  const ids: Array<number | undefined> = new Array(items.length).fill(undefined);
  const fresh = items.map((it, i) => ({ it, i })).filter(({ it }) => it.rec.rowId === undefined);
  const more = items.filter((it) => it.rec.rowId !== undefined);

  if (fresh.length > 0) {
    // Ids are taken first so each row's id is known without relying on the
    // order RETURNING gives them back in.
    const seq = await query<{ id: string }>(
      `SELECT nextval(pg_get_serial_sequence('netflow_sessions', 'id')) AS id FROM generate_series(1, $1)`,
      [fresh.length]
    );
    const col = <T>(f: (s: StoredSession) => T) => fresh.map(({ it }) => f(it));
    await query(
      `INSERT INTO netflow_sessions
         (id, device_id, exporter, protocol, client_addr, client_port, server_addr, server_port,
          client_nat_addr, client_nat_port, server_nat_addr, server_nat_port, client_mac, app,
          started_at, ended_at, bytes_out, bytes_in, packets_out, packets_in, flags_out, flags_in, end_reason)
       SELECT u.* FROM unnest($1::bigint[], $2::int[], $3::text[], $4::smallint[], $5::text[], $6::int[],
                              $7::text[], $8::int[], $9::text[], $10::int[], $11::text[], $12::int[],
                              $13::text[], $14::text[], $15::timestamptz[], $16::timestamptz[],
                              $17::bigint[], $18::bigint[], $19::bigint[], $20::bigint[],
                              $21::smallint[], $22::smallint[], $23::text[])
         AS u(id, device_id, exporter, protocol, client_addr, client_port, server_addr, server_port,
              client_nat_addr, client_nat_port, server_nat_addr, server_nat_port, client_mac, app,
              started_at, ended_at, bytes_out, bytes_in, packets_out, packets_in, flags_out, flags_in, end_reason)
        -- A device removed since its flows arrived would fail the whole batch.
        WHERE u.device_id IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id = u.device_id)`,
      [
        seq.map((r) => r.id),
        col((s) => s.deviceId),
        col((s) => (s.deviceId === null ? s.rec.exporterLabel : null)),
        col((s) => s.rec.protocol),
        col((s) => s.rec.client.addr),
        col((s) => s.rec.client.port),
        col((s) => s.rec.server.addr),
        col((s) => s.rec.server.port),
        col((s) => s.rec.clientNat?.addr ?? null),
        col((s) => s.rec.clientNat?.port ?? null),
        col((s) => s.rec.serverNat?.addr ?? null),
        col((s) => s.rec.serverNat?.port ?? null),
        col((s) => s.clientMac),
        col((s) => s.rec.app),
        col((s) => iso(s.rec.start)),
        col((s) => iso(s.rec.end)),
        col((s) => s.rec.bytesOut),
        col((s) => s.rec.bytesIn),
        col((s) => s.rec.packetsOut),
        col((s) => s.rec.packetsIn),
        col((s) => s.rec.flagsOut),
        col((s) => s.rec.flagsIn),
        col((s) => s.rec.reason),
      ]
    );
    fresh.forEach(({ i }, n) => { ids[i] = Number(seq[n].id); });
  }

  if (more.length > 0) {
    const col = <T>(f: (s: StoredSession) => T) => more.map(f);
    await query(
      `UPDATE netflow_sessions s SET
         started_at = LEAST(s.started_at, u.started_at),
         ended_at = GREATEST(s.ended_at, u.ended_at),
         bytes_out = s.bytes_out + u.bytes_out,
         bytes_in = s.bytes_in + u.bytes_in,
         packets_out = s.packets_out + u.packets_out,
         packets_in = s.packets_in + u.packets_in,
         flags_out = u.flags_out,
         flags_in = u.flags_in,
         end_reason = u.end_reason,
         client_nat_addr = COALESCE(s.client_nat_addr, u.client_nat_addr),
         client_nat_port = COALESCE(s.client_nat_port, u.client_nat_port),
         server_nat_addr = COALESCE(s.server_nat_addr, u.server_nat_addr),
         server_nat_port = COALESCE(s.server_nat_port, u.server_nat_port),
         updated_at = NOW()
       FROM unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[], $4::bigint[], $5::bigint[],
                   $6::bigint[], $7::bigint[], $8::smallint[], $9::smallint[], $10::text[],
                   $11::text[], $12::int[], $13::text[], $14::int[])
         AS u(id, started_at, ended_at, bytes_out, bytes_in, packets_out, packets_in, flags_out, flags_in,
              end_reason, client_nat_addr, client_nat_port, server_nat_addr, server_nat_port)
       WHERE s.id = u.id`,
      [
        col((s) => s.rec.rowId),
        col((s) => iso(s.rec.start)),
        col((s) => iso(s.rec.end)),
        col((s) => s.rec.bytesOut),
        col((s) => s.rec.bytesIn),
        col((s) => s.rec.packetsOut),
        col((s) => s.rec.packetsIn),
        col((s) => s.rec.flagsOut),
        col((s) => s.rec.flagsIn),
        col((s) => s.rec.reason),
        col((s) => s.rec.clientNat?.addr ?? null),
        col((s) => s.rec.clientNat?.port ?? null),
        col((s) => s.rec.serverNat?.addr ?? null),
        col((s) => s.rec.serverNat?.port ?? null),
      ]
    );
    more.forEach((it) => { ids[items.indexOf(it)] = it.rec.rowId; });
  }
  return ids;
}
