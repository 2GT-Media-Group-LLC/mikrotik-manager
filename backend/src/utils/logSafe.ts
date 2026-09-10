/**
 * Make an untrusted value safe to put in a log line.
 *
 * Log entries are newline-delimited, so a value containing a line break can
 * forge additional entries — an audit trail that can be written into by the
 * thing it is auditing is worse than no audit trail, because it is believed.
 *
 * Two sources matter and neither is under our control: values from HTTP
 * requests, and strings read off devices. A device identity is attacker-settable
 * on a compromised switch, and it appears in log lines throughout the collector.
 *
 * ## What this does NOT do
 *
 * It does not make a value safe to sit in a *format string*. `%` is left alone,
 * deliberately — mangling it would corrupt every legitimate "90% full" in the
 * logs to guard against a case that only arises one way:
 *
 *     BAD :  console.error(<template with ${logSafe(v)}>, err)  -- v can contain %s
 *     GOOD:  console.error('... %s', logSafe(v), err)          -- format string is a literal
 *
 * A single-argument call is safe either way, because Node substitutes nothing
 * when there is nothing to substitute. The danger is only an interpolated value
 * in the format position *with further arguments after it*, which is what
 * console-format.test.ts checks for.
 */

/** Longest a single interpolated value may be before it is truncated. */
const MAX_LEN = 200;

export function logSafe(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);

  // CR, LF, other C0 controls and DEL. Replaced rather than stripped so that a
  // tampered value reads as tampered instead of being silently tidied up.
  // eslint-disable-next-line no-control-regex
  const flattened = text.replace(/[\u0000-\u001F\u007F]/g, '\u2423');

  return flattened.length > MAX_LEN ? `${flattened.slice(0, MAX_LEN)}…` : flattened;
}
