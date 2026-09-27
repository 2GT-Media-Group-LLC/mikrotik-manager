/**
 * Converting old Config Templates into command templates (#163).
 *
 * Config Templates could only set DNS servers, NTP servers and a syslog host,
 * applied over the API to every chosen device at once. Command templates run
 * any console commands through Bulk Commands, in waves and with Change Guard,
 * so the old kind is a subset and the two are merged into one library.
 *
 * The commands reproduce what the old apply did, including its quirks:
 *   - syslog updated only the first remote logging action, and did nothing
 *     when there was none (it never created one)
 *   - NTP had a fallback for RouterOS v6's primary/secondary fields; the
 *     converted command uses v7 syntax, and the description says so
 */

export interface OldConfigTemplate {
  name: string;
  description?: string | null;
  applies_to_type?: string | null;
  template_json?: {
    dns_servers?: string[];
    ntp_servers?: string[];
    syslog_host?: string;
  } | null;
}

/**
 * A RouterOS console string literal. Backslash, double quote and $ (variable
 * expansion) are escaped, so a stored value can only ever be data.
 */
export function rosQuote(v: string): string {
  return `"${v.replace(/[\\"$]/g, (m) => `\\${m}`)}"`;
}

const clean = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((s) => String(s).trim()).filter(Boolean) : [];

export function configTemplateToCommand(t: OldConfigTemplate): { command: string; description: string } | null {
  const tj = t.template_json ?? {};
  const lines: string[] = [];
  const dns = clean(tj.dns_servers);
  const ntp = clean(tj.ntp_servers);
  const syslog = String(tj.syslog_host ?? '').trim();

  if (dns.length) lines.push(`/ip dns set servers=${rosQuote(dns.join(','))}`);
  if (ntp.length) lines.push(`/system ntp client set enabled=yes servers=${rosQuote(ntp.join(','))}`);
  if (syslog) {
    lines.push(
      `:local a [/system logging action find target=remote]; ` +
      `:if ([:len $a] > 0) do={ /system logging action set ($a->0) remote=${rosQuote(syslog)} }`
    );
  }
  if (!lines.length) return null;

  const notes = [
    t.description?.trim() || null,
    'Converted from a Config Template.',
    ntp.length ? 'The NTP line uses RouterOS v7 syntax.' : null,
    t.applies_to_type ? `Intended for ${t.applies_to_type} devices.` : null,
  ].filter(Boolean);
  return { command: lines.join('\n'), description: notes.join(' ') };
}
