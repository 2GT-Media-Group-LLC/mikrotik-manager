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

/**
 * SQL expression for the log prefix of a firewall packet log line: the text
 * before the chain, trimmed (empty when the rule logs without one). RouterOS
 * writes `<prefix> <chain>: …`.
 */
export function firewallPrefixSql(
  alias: FirewallSqlAlias = ''
): string {
  const p = alias ? `${alias}.` : '';

  return `btrim(COALESCE(
    NULLIF(split_part(${p}message, ' input:', 1), ${p}message),
    NULLIF(split_part(${p}message, ' forward:', 1), ${p}message),
    NULLIF(split_part(${p}message, ' output:', 1), ${p}message),
    ''
  ))`;
}
