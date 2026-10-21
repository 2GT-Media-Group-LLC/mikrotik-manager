export type FirewallSqlAlias = '' | 'e';

/**
 * SQL predicate identifying RouterOS firewall packet log lines.
 *
 * Keep this definition shared by Firewall Logs, Device Logs filtering,
 * retention and clear operations so they cannot drift apart.
 */
export function firewallPacketLogSql(
  alias: FirewallSqlAlias = ''
): string {
  const p = alias ? `${alias}.` : '';

  return `COALESCE((
    'firewall' = ANY(string_to_array(${p}topic, ','))
    AND ${p}message ~* '(input|forward|output):'
    AND ${p}message ~* '(^|[[:space:],])proto[[:space:]]+'
    AND ${p}message LIKE '%->%'
  ), FALSE)`;
}
