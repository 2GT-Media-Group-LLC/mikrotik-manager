/**
 * Rule tags (#369): `mtm#` and four letters or digits at the end of a
 * firewall rule's log prefix, unique on the device. A log line carries its
 * rule's prefix, so the tag leads from the line to the rule and back. The
 * manager adds them (backend utils/ruleTags.ts); this only reads them.
 */
const TAG = /(?:^|\s)mtm#([0-9a-z]{4})(?=\s|$)/i;

export function tagOf(prefix: string | null | undefined): string | null {
  const m = TAG.exec(prefix ?? '');
  return m ? m[1].toLowerCase() : null;
}

const yes = (v: string | undefined) => v === 'yes' || v === 'true';

/** A configured rule that logs without a tag yet. */
export function logsUntagged(r: Record<string, string>): boolean {
  return yes(r.log) && !yes(r.dynamic) && !tagOf(r['log-prefix']);
}

/** Firewall Events, filtered to one rule's lines. */
export function ruleLinesUrl(deviceId: number, tag: string): string {
  return `/firewall-events?device=${deviceId}&search=${encodeURIComponent(`mtm#${tag}`)}`;
}

/** The rule on its device's Firewall tab, picked out. */
export function ruleUrl(deviceId: number, tag: string): string {
  return `/devices/${deviceId}?tab=firewall&rule=${tag}`;
}
