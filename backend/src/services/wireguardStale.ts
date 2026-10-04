/**
 * Stale WireGuard peers (#208): a peer whose last handshake is older than the
 * alert rule's threshold, in minutes.
 *
 * WireGuard re-handshakes about every two minutes while traffic flows, and a
 * peer with persistent-keepalive does so even when idle, so a handshake far
 * older than that means the tunnel is down. A peer that has never completed a
 * handshake is left out (a new or standby peer would otherwise alert forever),
 * as are disabled peers and peers on a disabled interface.
 */
import { query } from '../config/database';
import { alertService } from './AlertService';

export const DEFAULT_STALE_MINUTES = 15;

export interface PeerRow {
  device_id: number;
  device_name: string;
  peer_id: string;
  interface: string | null;
  name: string | null;
  public_key: string | null;
  endpoint: string | null;
  last_handshake_sec: number | null;
  disabled: boolean;
  interface_disabled: boolean;
  /** Seconds since the row was polled. */
  polled_ago_sec: number;
}

/** The peers past the threshold, with how long ago their last handshake was. */
export function stalePeers(rows: PeerRow[], thresholdMin: number): (PeerRow & { age_sec: number })[] {
  const limit = Math.max(1, thresholdMin) * 60;
  return rows
    .filter((r) => !r.disabled && !r.interface_disabled && r.last_handshake_sec !== null)
    .map((r) => ({ ...r, age_sec: (r.last_handshake_sec as number) + Math.max(0, r.polled_ago_sec) }))
    .filter((r) => r.age_sec > limit);
}

export function peerLabel(r: Pick<PeerRow, 'name' | 'endpoint' | 'public_key'>): string {
  if (r.name) return r.name;
  if (r.endpoint) return r.endpoint;
  if (r.public_key) return `${r.public_key.slice(0, 8)}…`;
  return 'unnamed peer';
}

export function humanAge(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86_400)} days`;
}

/** Alert on every stale peer; the rule's cooldown applies per peer. */
export async function checkWireGuardStale(): Promise<void> {
  const rule = await alertService.getRule('wireguard_stale');
  if (!rule?.enabled) return;
  const threshold = rule.threshold && rule.threshold > 0 ? rule.threshold : DEFAULT_STALE_MINUTES;
  const rows = await query<PeerRow>(
    `SELECT w.device_id, d.name AS device_name, w.peer_id, w.interface, w.name, w.public_key, w.endpoint,
            w.last_handshake_sec, w.disabled, w.interface_disabled,
            EXTRACT(EPOCH FROM NOW() - w.updated_at)::int AS polled_ago_sec
       FROM wireguard_peers w JOIN devices d ON d.id = w.device_id
      -- A peer not polled for a day belongs to a device that is offline or gone;
      -- the device's own offline alert covers it.
      WHERE w.updated_at > NOW() - INTERVAL '1 day'`
  );
  for (const p of stalePeers(rows, threshold)) {
    await alertService.dispatch(
      'wireguard_stale',
      `WireGuard peer "${peerLabel(p)}" on ${p.interface ?? 'an interface'} hasn't completed a handshake in ` +
        `${humanAge(p.age_sec)} (alert after ${threshold} min).`,
      { deviceId: p.device_id, deviceName: p.device_name.trim(), cooldownKey: `wireguard_stale:${p.device_id}:${p.peer_id}` }
    );
  }
}
