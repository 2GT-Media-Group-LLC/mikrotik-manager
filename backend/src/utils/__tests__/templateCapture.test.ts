import { captureCommands, rosValue } from '../templateCapture';

describe('template captured from a device (Discussion #85)', () => {
  it('quotes values the CLI would misread, and escapes what could run', () => {
    expect(rosValue('1.1.1.1,8.8.8.8')).toBe('1.1.1.1,8.8.8.8');
    expect(rosValue('')).toBe('""');
    expect(rosValue('NOC "west" $1 \\x')).toBe('"NOC \\"west\\" \\$1 \\\\x"');
    expect(rosValue('Rack 4; reboot')).toBe('"Rack 4; reboot"');
  });

  it('writes DNS, NTP for RouterOS 7, services, SNMP, syslog and time zone', () => {
    const { lines, skipped } = captureCommands({
      rosMajor: 7,
      dns: { servers: '1.1.1.1,9.9.9.9', 'allow-remote-requests': 'true' },
      ntp: { enabled: 'true', servers: 'pool.ntp.org' },
      services: [
        { name: 'telnet', port: '23', disabled: 'true', address: '' },
        { name: 'api-ssl', port: '8729', disabled: 'false', address: '10.0.0.0/8' },
        { name: 'api-ssl', dynamic: 'true' },
      ],
      snmp: { enabled: 'true', contact: 'NOC', location: 'Rack 4', 'trap-community': 'secret' },
      loggingActions: [{ name: 'memory', target: 'memory' }, { name: 'remote', target: 'remote', remote: '10.0.0.5', 'remote-port': '514' }],
      clock: { 'time-zone-name': 'Europe/Amsterdam', 'time-zone-autodetect': 'false' },
    }, ['dns', 'ntp', 'services', 'snmp', 'syslog', 'clock']);
    expect(lines).toEqual([
      '/ip dns set servers=1.1.1.1,9.9.9.9 allow-remote-requests=yes',
      '/system ntp client set enabled=yes servers=pool.ntp.org',
      '/ip service set [ find name=telnet ] disabled=yes port=23 address=""',
      '/ip service set [ find name=api-ssl ] disabled=no port=8729 address=10.0.0.0/8',
      '/snmp set enabled=yes contact=NOC location="Rack 4"',
      '/system logging action set [ find name=remote ] remote=10.0.0.5 remote-port=514',
      '/system clock set time-zone-autodetect=no time-zone-name=Europe/Amsterdam',
    ]);
    expect(skipped).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/secret/);
  });

  it('writes RouterOS 6 NTP its own way, and says what it skipped', () => {
    const { lines, skipped } = captureCommands({
      rosMajor: 6,
      ntp: { enabled: 'true', 'primary-ntp': '10.0.0.1', 'secondary-ntp': '0.0.0.0' },
      loggingActions: [{ name: 'remote', target: 'remote', remote: '0.0.0.0' }],
    }, ['ntp', 'syslog', 'dns']);
    expect(lines).toEqual(['/system ntp client set enabled=yes primary-ntp=10.0.0.1 secondary-ntp=0.0.0.0']);
    expect(skipped).toEqual(['Remote syslog: none set on this device', 'DNS: not read']);
  });
});
