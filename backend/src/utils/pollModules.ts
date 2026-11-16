/**
 * Switching off collectors a fleet does not want.
 *
 * Asked for by an operator running roughly 1,500 devices: "the capability to
 * disable modules like polling clients or neighbor discovery would be helpful
 * to limit the amount of traffic to and from router."
 *
 * He is pointing at the right constraint. Capacity is bounded by how long a
 * poll takes multiplied by how many devices there are, and on the reference
 * fleet a slow poll averages 12.9 seconds. Every collector inside it is a round
 * trip a fleet may not need: a site doing firmware and configuration management
 * has no use for per-client tracking, and turning it off removes work from
 * every device on every cycle rather than shaving milliseconds.
 *
 * Defaults are all-on, so an existing install behaves exactly as before. These
 * reduce what is gathered, so each one costs a feature — that is the trade being
 * offered, and the UI should say so rather than presenting them as tuning.
 */

export interface PollModules {
  /** Per-client tracking on the fast poll. Off: no client list, no per-client traffic. */
  clients: boolean;
  /** LLDP/CDP/MNDP neighbours. Off: topology stops updating. */
  neighbors: boolean;
  /** Device log ingestion. Off: no events, and nothing that reads them. */
  logs: boolean;
  /** Certificate inventory on the slow poll. Off: no expiry warnings. */
  certificates: boolean;
  /**
   * The DNS cache of routers that answer DNS, on the fast poll (#366). Off:
   * addresses are named only by their owner, reverse DNS and AdGuard Home.
   */
  dnsCache: boolean;
}

export const ALL_MODULES: PollModules = {
  clients: true,
  neighbors: true,
  logs: true,
  certificates: true,
  dnsCache: true,
};

export const MODULE_SETTING_KEYS = [
  'poll_clients_enabled',
  'poll_neighbors_enabled',
  'poll_logs_enabled',
  'poll_certificates_enabled',
  'poll_dns_cache_enabled',
] as const;

/**
 * Read the toggles out of app_settings.
 *
 * Anything missing or unparseable is treated as enabled. A misread setting
 * should cost extra polling, never silently stop collecting something the
 * operator still believes is being gathered.
 */
export function resolveModules(settings: Record<string, unknown>): PollModules {
  const on = (key: string): boolean => settings[key] !== false;
  return {
    clients: on('poll_clients_enabled'),
    neighbors: on('poll_neighbors_enabled'),
    logs: on('poll_logs_enabled'),
    certificates: on('poll_certificates_enabled'),
    dnsCache: on('poll_dns_cache_enabled'),
  };
}

/** Human summary for the startup log, so a quiet fleet is explained. */
export function describeDisabled(m: PollModules): string | null {
  const off = (Object.keys(ALL_MODULES) as (keyof PollModules)[]).filter((k) => !m[k]);
  return off.length ? off.join(', ') : null;
}
