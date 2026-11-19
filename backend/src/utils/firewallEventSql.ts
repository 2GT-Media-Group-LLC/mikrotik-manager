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
    AND ${p}message ~ '[^[:space:]]+: in:'
    AND ${p}message ~* '(^|[[:space:],])proto[[:space:]]+'
    AND ${p}message LIKE '%->%'
  ), FALSE)`;
}

/**
 * SQL expression for the log prefix of a firewall packet log line: the text
 * before the chain, trimmed (empty when the rule logs without one). RouterOS
 * writes `<prefix> <chain>: in:…`, the chain being input, forward, output or
 * the name of a chain of the user's own.
 */
export function firewallPrefixSql(
  alias: FirewallSqlAlias = ''
): string {
  const p = alias ? `${alias}.` : '';

  return `btrim(COALESCE(
    NULLIF(split_part(${p}message, ' input:', 1), ${p}message),
    NULLIF(split_part(${p}message, ' forward:', 1), ${p}message),
    NULLIF(split_part(${p}message, ' output:', 1), ${p}message),
    -- A rule in a chain of its own (a jump target) logs under that chain's
    -- name (#369); only those lines get this far.
    substring(${p}message from '^(.*)[[:space:]][^[:space:]]+: in:'),
    ''
  ))`;
}

/**
 * Most rules the Hide filter takes at once. Express's query parser turns a
 * longer list into an object, and the usual wish ("everything except the
 * internet scans") is a handful of rules.
 */
export const FIREWALL_HIDE_MAX = 20;

/** Rules to leave out of Firewall Logs: one device and one whole prefix each. */
export type HiddenRules = { deviceIds: number[]; prefixes: string[] };

/**
 * `?hide=` as hidden rules. Each value is `<deviceId>|<prefix>`: a prefix is
 * one rule on one device only (tags are unique per device, and hand-written
 * prefixes repeat across routers). Undefined for none, null when malformed.
 */
export function parseHiddenRules(raw: unknown, maxPrefix: number): HiddenRules | undefined | null {
  if (raw === undefined) return undefined;
  const values = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(values) || values.length > FIREWALL_HIDE_MAX) return null;
  const deviceIds: number[] = [];
  const prefixes: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') return null;
    const cut = v.indexOf('|');
    const id = cut > 0 ? v.slice(0, cut) : '';
    const prefix = v.slice(cut + 1).trim();
    if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2_147_483_647) return null;
    if (!prefix || prefix.length > maxPrefix) return null;
    deviceIds.push(Number(id));
    prefixes.push(prefix);
  }
  return deviceIds.length ? { deviceIds, prefixes } : undefined;
}

/**
 * SQL predicate keeping the lines of every rule but the hidden ones. Lines
 * without a prefix, or from no device, are never hidden: nothing names their
 * rule. `$devices` is an int[] and `$prefixes` a text[] of the same length.
 */
export function firewallHideSql(
  alias: FirewallSqlAlias,
  devicesParam: number,
  prefixesParam: number
): string {
  const p = alias ? `${alias}.` : '';

  return `NOT EXISTS (
    SELECT 1 FROM unnest($${devicesParam}::int[], $${prefixesParam}::text[]) AS h(device_id, prefix)
     WHERE h.device_id = ${p}device_id AND h.prefix = ${firewallPrefixSql(alias)}
  )`;
}

/**
 * SQL for a firewall log line's built-in chain: input, forward or output. A
 * rule in a chain of its own logs under that chain's name (#369), so the
 * built-in one is read from the interfaces: no out-interface is input, no
 * in-interface is output. Mirrors parseFirewallLog.
 */
export function firewallBaseChainSql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return `(CASE
    WHEN ${p}message ~ '(^|[[:space:]])input: in:' THEN 'input'
    WHEN ${p}message ~ '(^|[[:space:]])forward: in:' THEN 'forward'
    WHEN ${p}message ~ '(^|[[:space:]])output: in:' THEN 'output'
    WHEN ${p}message ~ ' out:[(]unknown [0-9]+[)]' THEN 'input'
    WHEN ${p}message ~ ': in:[(]unknown [0-9]+[)]' THEN 'output'
    ELSE 'forward' END)`;
}
