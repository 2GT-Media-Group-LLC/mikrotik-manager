/** Validated inputs for GET /api/proxy/top. Only trusted literals reach the SQL. */

const RANGES: Record<string, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

const GROUPS = {
  client: { key: 'client_ip', where: `status = 'ok'`, distinct: 'COALESCE(hostname, server_ip)' },
  user: { key: 'auth_user', where: `status = 'ok' AND auth_user IS NOT NULL`, distinct: 'client_ip' },
  destination: { key: 'COALESCE(hostname, server_ip)', where: `status = 'ok' AND COALESCE(hostname, server_ip) IS NOT NULL`, distinct: 'client_ip' },
  denied: { key: 'client_ip', where: `status <> 'ok' AND auth_user IS NULL`, distinct: 'proxy_port::text' },
} as const;

export type ProxyGroup = (typeof GROUPS)[keyof typeof GROUPS];

export type ProxyQueryChoice =
  | { group: ProxyGroup; interval: string }
  | { error: string };

/**
 * Resolve the `by` and `range` query values. Own-property checks are required:
 * plain-object lookups would otherwise accept inherited names such as
 * "constructor" or "toString" and build SQL from a function.
 */
export function resolveProxyQuery(byRaw: unknown, rangeRaw: unknown): ProxyQueryChoice {
  const by = String(byRaw || 'client');
  if (!Object.hasOwn(GROUPS, by)) return { error: 'Invalid "by" value' };
  const range = String(rangeRaw || '24h');
  if (!Object.hasOwn(RANGES, range)) return { error: 'Invalid "range" value' };
  return { group: GROUPS[by as keyof typeof GROUPS], interval: RANGES[range] };
}
