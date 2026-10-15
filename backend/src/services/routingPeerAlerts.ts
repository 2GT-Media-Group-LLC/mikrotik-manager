/**
 * Routing peer down (#279): a BGP session or OSPF neighbour that has been up
 * and has now been down for the rule's threshold, in minutes. A peer that has
 * never come up (a standby, or one still being set up) is left out, as are
 * disabled BGP connections, so a quiet one doesn't alert forever.
 */
import { query } from '../config/database';
import { alertService } from './AlertService';

export const DEFAULT_DOWN_MINUTES = 2;

export interface DownPeerRow {
  device_id: number;
  device_name: string;
  protocol: 'bgp' | 'ospf';
  peer_key: string;
  name: string | null;
  remote_address: string | null;
  remote_as: string | null;
  instance: string | null;
  state: string;
  down_sec: number;
}

export function peerDescription(p: Pick<DownPeerRow, 'protocol' | 'name' | 'remote_address' | 'remote_as' | 'instance'>): string {
  if (p.protocol === 'bgp') {
    const remote = [p.remote_address, p.remote_as ? `AS ${p.remote_as}` : null].filter(Boolean).join(', ');
    return `BGP peer "${p.name ?? p.remote_address ?? 'unnamed'}"${remote ? ` (${remote})` : ''}`;
  }
  return `OSPF neighbour ${p.name ?? p.remote_address ?? 'unknown'}${p.instance ? ` in ${p.instance}` : ''}`;
}

function humanDown(sec: number): string {
  if (sec < 120) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

/** Alert on every peer down past the threshold; the rule's cooldown applies per peer. */
export async function checkRoutingPeers(): Promise<void> {
  const rule = await alertService.getRule('routing_peer_down');
  if (!rule?.enabled) return;
  const threshold = rule.threshold && rule.threshold > 0 ? rule.threshold : DEFAULT_DOWN_MINUTES;
  const rows = await query<DownPeerRow>(
    `SELECT r.device_id, d.name AS device_name, r.protocol, r.peer_key, r.name, r.remote_address, r.remote_as,
            r.instance, r.state, EXTRACT(EPOCH FROM NOW() - r.last_change_at)::int AS down_sec
       FROM routing_peers r JOIN devices d ON d.id = r.device_id
      WHERE NOT r.up AND NOT r.disabled AND r.last_up_at IS NOT NULL
        AND r.last_change_at < NOW() - ($1 || ' minutes')::interval
        -- Not polled for a day: the device is offline or gone, and its own
        -- offline alert covers it.
        AND r.updated_at > NOW() - INTERVAL '1 day'`,
    [String(threshold)]
  );
  for (const p of rows) {
    await alertService.dispatch(
      'routing_peer_down',
      `${peerDescription(p)} on ${p.device_name.trim()} has been down for ${humanDown(p.down_sec)}${p.state === 'down' ? '' : ` (now ${p.state})`}.`,
      { deviceId: p.device_id, deviceName: p.device_name.trim(), cooldownKey: `routing_peer_down:${p.device_id}:${p.protocol}:${p.peer_key}` }
    );
  }
}
