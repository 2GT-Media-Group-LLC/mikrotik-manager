/**
 * Remote logging actions across RouterOS versions (outside review C7).
 *
 * The form speaks the older schema: `bsd-syslog=yes|no` with
 * `syslog-facility` and `syslog-severity`. Current RouterOS 7 has no
 * `bsd-syslog`: the format is `remote-log-format` (`default`, `syslog`, ...),
 * the timestamp style `syslog-time-format`, and facility and severity apply
 * only with `remote-log-format=syslog`. Sending the old keys there failed
 * with "unknown parameter bsd-syslog".
 *
 * Which schema a device uses is read from its own actions: every device has
 * the built-in `remote` action, which lists `remote-log-format` when the
 * newer schema is in use.
 */

export function usesRemoteLogFormat(actions: Record<string, string>[]): boolean {
  return actions.some((a) => 'remote-log-format' in a);
}

export function toSyslogActionParams(params: Record<string, string>, remoteLogFormat: boolean): Record<string, string> {
  if (!remoteLogFormat) return params;
  const { 'bsd-syslog': bsd, ...out } = params;
  const syslogStyle = bsd !== undefined || 'syslog-facility' in out || 'syslog-severity' in out;
  if (syslogStyle) {
    out['remote-log-format'] = 'syslog';
    if (bsd !== undefined) out['syslog-time-format'] = bsd === 'yes' ? 'bsd-syslog' : 'iso8601';
  }
  return out;
}

/** Whether an action, in either schema, sends BSD-style syslog. */
export function isBsdSyslog(action: Record<string, string>): boolean {
  if ('remote-log-format' in action) return action['syslog-time-format'] === 'bsd-syslog';
  return action['bsd-syslog'] === 'yes' || action['bsd-syslog'] === 'true';
}
