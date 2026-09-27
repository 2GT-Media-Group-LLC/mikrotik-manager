import { configTemplateToCommand, rosQuote } from '../configTemplateConvert';

describe('configTemplateToCommand (#163)', () => {
  it('converts the template on the reference install', () => {
    const r = configTemplateToCommand({
      name: 'Standard Switch Config',
      template_json: { dns_servers: ['172.24.1.15', '172.24.1.16'], ntp_servers: ['pool.ntp.org'] },
    });
    expect(r?.command).toBe(
      '/ip dns set servers="172.24.1.15,172.24.1.16"\n' +
      '/system ntp client set enabled=yes servers="pool.ntp.org"'
    );
    expect(r?.description).toMatch(/Converted from a Config Template\. The NTP line uses RouterOS v7 syntax\./);
  });

  it('updates only the first remote logging action, and none if there is none, as before', () => {
    const r = configTemplateToCommand({ name: 'x', template_json: { syslog_host: '10.0.0.5' } });
    expect(r?.command).toBe(
      ':local a [/system logging action find target=remote]; ' +
      ':if ([:len $a] > 0) do={ /system logging action set ($a->0) remote="10.0.0.5" }'
    );
  });

  it('keeps the old description and device type', () => {
    const r = configTemplateToCommand({
      name: 'x', description: 'Branch defaults', applies_to_type: 'switch', template_json: { dns_servers: ['1.1.1.1'] },
    });
    expect(r?.description).toBe('Branch defaults Converted from a Config Template. Intended for switch devices.');
  });

  it('skips a template with nothing in it', () => {
    expect(configTemplateToCommand({ name: 'empty', template_json: {} })).toBeNull();
    expect(configTemplateToCommand({ name: 'blank', template_json: { dns_servers: [' '], syslog_host: '' } })).toBeNull();
  });

  it('cannot be turned into extra commands by a stored value', () => {
    expect(rosQuote('1.1.1.1"; /system reset-configuration; "')).toBe('"1.1.1.1\\"; /system reset-configuration; \\""');
    expect(rosQuote('$evil')).toBe('"\\$evil"');
    expect(rosQuote('a\\b')).toBe('"a\\\\b"');
  });
});
