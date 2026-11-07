/**
 * Rule tags (#369 phase 1): which firewall rule wrote a log line.
 *
 * RouterOS puts a rule's log prefix, and nothing else about the rule, in front
 * of its log lines:
 *
 *     MTM-FW-DROP mtm#7f3a input: in:ether1 out:(unknown 0), proto TCP ...
 *
 * So a rule that logs carries a short tag, `mtm#` and four letters or digits,
 * at the end of its prefix, after any prefix already there. The tag is unique
 * on the device; Firewall Events reads it off a line to link to the rule, and
 * the rule links back to its lines.
 */
import { randomInt } from 'crypto';

const TAG = /(?:^|\s)mtm#([0-9a-z]{4})(?=\s|$)/i;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

const yes = (v: string | undefined) => v === 'yes' || v === 'true';

/** The tag in a rule's log prefix, or null. */
export function tagOf(prefix: string | null | undefined): string | null {
  const m = TAG.exec(prefix ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** A prefix with the tag on the end, keeping what was there. */
export function withTag(prefix: string | null | undefined, tag: string): string {
  const base = (prefix ?? '').replace(TAG, ' ').replace(/\s+/g, ' ').trim();
  return base ? `${base} mtm#${tag}` : `mtm#${tag}`;
}

/** A tag no rule in `taken` has. */
export function newTag(taken: Set<string>): string {
  for (;;) {
    const t = Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (!taken.has(t)) return t;
  }
}

/** Every tag on the device's rules, across tables. */
export function tagsIn(...tables: Record<string, string>[][]): Set<string> {
  return new Set(tables.flat().map((r) => tagOf(r['log-prefix'])).filter((t): t is string => !!t));
}

/** Whether a rule logs and could take a tag (configured, not dynamic). */
export function logsUntagged(r: Record<string, string>): boolean {
  return yes(r.log) && !yes(r.dynamic) && !tagOf(r['log-prefix']) && !!r['.id'];
}

/** The prefix changes that tag every logging rule without one. Tags already used are avoided. */
export function planTags(rules: Record<string, string>[], taken: Set<string>): { id: string; from: string; to: string }[] {
  const used = new Set(taken);
  return rules.filter(logsUntagged).map((r) => {
    const tag = newTag(used);
    used.add(tag);
    return { id: r['.id'], from: r['log-prefix'] ?? '', to: withTag(r['log-prefix'], tag) };
  });
}

/**
 * A new or edited rule's params with a tag added when it logs and has none.
 * An edit that leaves logging alone, or turns it off, is left as it is.
 */
export function tagParams(params: Record<string, string>, taken: Set<string>): Record<string, string> {
  if (!yes(params.log) || tagOf(params['log-prefix'])) return params;
  return { ...params, 'log-prefix': withTag(params['log-prefix'], newTag(taken)) };
}

/** The tag on a firewall log line, read from its prefix (before the chain). */
export function tagOfLogLine(message: string): string | null {
  const head = /^(.*?)\s(?:input|forward|output|prerouting|postrouting|srcnat|dstnat|[\w-]+):\s/.exec(message)?.[1] ?? '';
  return tagOf(head);
}
