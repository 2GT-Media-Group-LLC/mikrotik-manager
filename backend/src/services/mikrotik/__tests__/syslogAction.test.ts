import { usesRemoteLogFormat, toSyslogActionParams, isBsdSyslog } from '../syslogAction';

describe('syslog actions across RouterOS versions (C7)', () => {
  const form = { name: 'siem', target: 'remote', remote: '10.0.0.9', 'syslog-facility': 'daemon', 'syslog-severity': 'auto', 'bsd-syslog': 'yes' };

  it('detects the schema from the built-in remote action', () => {
    expect(usesRemoteLogFormat([{ name: 'remote', target: 'remote', 'remote-log-format': 'default' }])).toBe(true);
    expect(usesRemoteLogFormat([{ name: 'remote', target: 'remote', 'bsd-syslog': 'false' }])).toBe(false);
  });

  it('leaves the older schema alone', () => {
    expect(toSyslogActionParams(form, false)).toEqual(form);
  });

  it('translates to remote-log-format on current RouterOS 7', () => {
    expect(toSyslogActionParams(form, true)).toEqual({
      name: 'siem', target: 'remote', remote: '10.0.0.9', 'syslog-facility': 'daemon', 'syslog-severity': 'auto',
      'remote-log-format': 'syslog', 'syslog-time-format': 'bsd-syslog',
    });
    expect(toSyslogActionParams({ ...form, 'bsd-syslog': 'no' }, true)['syslog-time-format']).toBe('iso8601');
    expect(toSyslogActionParams({ name: 'm', target: 'memory' }, true)).toEqual({ name: 'm', target: 'memory' });
  });

  it('reads BSD style from either schema', () => {
    expect(isBsdSyslog({ 'remote-log-format': 'syslog', 'syslog-time-format': 'bsd-syslog' })).toBe(true);
    expect(isBsdSyslog({ 'remote-log-format': 'default' })).toBe(false);
    expect(isBsdSyslog({ 'bsd-syslog': 'yes' })).toBe(true);
  });
});
