/**
 * Tunnel down (#310): an IPsec peer, EoIP, GRE or IPIP tunnel, or PPPoE client
 * that has been up and has now been down for the rule's threshold, in minutes.
 * Ones that have never come up, disabled ones, passive peers and servers
 * waiting for someone, and PPP sessions (they end, they don't go down) are
 * left out, as for routing peers.
 */
import { query } from '../config/database';
import { alertService } from './AlertService';

export const DEFAULT_TUNNEL_DOWN_MINUTES = 5;

const LABEL: Record<string, string> = {
  ipsec: 'IPsec peer', eoip: 'EoIP tunnel', gre: 'GRE tunnel', ipip: 'IPIP tunnel', 'pppoe-client': 'PPPoE client',
};

export interface DownTunnelRow {
  device_id: number;
  device_name: string;
  kind: string;
  tunnel_key: string;
  name: string;
  remote_address: string | null;
  state: string;
  down_sec: number;
}

export function tunnelDescription(t: Pick<DownTunnelRow, 'kind' | 'name' | 'remote_address'>): string {
  return `${LABEL[t.kind] ?? t.kind} "${t.name}"${t.remote_address ? ` (to ${t.remote_address})` : ''}`;
}

function humanDown(sec: number): string {
  if (sec < 120) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

/** Alert on every tunnel down past the threshold; the rule's cooldown applies per tunnel. */
export async function checkTunnels(): Promise<void> {
  const rule = await alertService.getRule('tunnel_down');
  if (!rule?.enabled) return;
  const threshold = rule.threshold && rule.threshold > 0 ? rule.threshold : DEFAULT_TUNNEL_DOWN_MINUTES;
  const rows = await query<DownTunnelRow>(
    `SELECT t.device_id, d.name AS device_name, t.kind, t.tunnel_key, t.name, t.remote_address, t.state,
            EXTRACT(EPOCH FROM NOW() - t.last_change_at)::int AS down_sec
       FROM device_tunnels t JOIN devices d ON d.id = t.device_id
      WHERE t.status = 'down' AND t.kind = ANY($2::text[]) AND t.last_up_at IS NOT NULL
        AND t.last_change_at < NOW() - ($1 || ' minutes')::interval
        -- Not polled for a day: the device is offline or gone, and its own
        -- offline alert covers it.
        AND t.updated_at > NOW() - INTERVAL '1 day'`,
    [String(threshold), Object.keys(LABEL)]
  );
  for (const t of rows) {
    await alertService.dispatch(
      'tunnel_down',
      `${tunnelDescription(t)} on ${t.device_name.trim()} has been down for ${humanDown(t.down_sec)} (${t.state}).`,
      { deviceId: t.device_id, deviceName: t.device_name.trim(), cooldownKey: `tunnel_down:${t.device_id}:${t.kind}:${t.tunnel_key}` }
    );
  }
}
