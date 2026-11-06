import {
  conntrackActive, conntrackFields, dropRules, dropRates, chainField, coreLoads, temperatures, linkSpeedBps,
} from '../deviceGraphs';

describe('device graphs (#402)', () => {
  it('reads conntrack only where it runs', () => {
    expect(conntrackActive({ enabled: 'auto', 'active-ipv4': 'false', 'active-ipv6': 'false', 'total-entries': '0' })).toBe(false);
    expect(conntrackActive({ enabled: 'auto', 'active-ipv4': 'true' })).toBe(true);
    // RouterOS 6 has no active-* fields: entries are the only sign.
    expect(conntrackActive({ enabled: 'auto', 'total-entries': '12' })).toBe(true);
    // RouterOS 7 with auto switched off but two entries left behind.
    expect(conntrackActive({ enabled: 'auto', 'active-ipv4': 'false', 'active-ipv6': 'false', 'total-entries': '2' })).toBe(false);
    expect(conntrackActive({ enabled: 'yes' })).toBe(true);
    expect(conntrackActive({ enabled: 'no', 'total-entries': '5' })).toBe(false);
    expect(conntrackFields({ 'total-entries': '18200', 'max-entries': '262144', 'total-ip4-entries': '18000', 'total-ip6-entries': '200' }))
      .toEqual({ total: 18200, max: 262144, ipv4: 18000, ipv6: 200 });
  });

  it('turns drop counters into packets per second per chain, and per rule', () => {
    const filter: Record<string, string>[] = [
      { '.id': '*1', chain: 'input', action: 'drop', packets: '100', comment: 'drop invalid' },
      { '.id': '*2', chain: 'forward', action: 'drop', packets: '50' },
      { '.id': '*3', chain: 'input', action: 'accept', packets: '9999' },
      { '.id': '*4', chain: 'input', action: 'drop', packets: '7', disabled: 'true' },
    ];
    const raw = [{ '.id': '*9', chain: 'prerouting', action: 'drop', packets: '10' }];
    const first = dropRates(undefined, dropRules(filter, raw), null, 0);
    expect(first.perChain).toBeNull();
    const later = dropRules(
      [{ ...filter[0], packets: '400' }, { ...filter[1], packets: '20' }, filter[2], { '.id': '*5', chain: 'input', action: 'reject', packets: '3' }],
      [{ ...raw[0], packets: '70' }]);
    const r = dropRates(first.sample, later, null, 30_000);
    // *1: +300 in 30 s; *2 went down (reset) and *5 is new, so both skipped this time.
    expect(r.perChain).toEqual({ input: 10, forward: 0, 'raw-prerouting': 2 });
    expect(r.perRule.map((x) => [x.rule.label, x.packets])).toEqual([['drop invalid', 300], ['raw-prerouting drop *9', 60]]);
    expect(chainField('raw-prerouting')).toBe('pps_raw_prerouting');
  });

  it('counts new connections from the marker rule', () => {
    const a = dropRates(undefined, [], 1000, 0);
    expect(dropRates(a.sample, [], 1600, 60_000).newConnPerSec).toBe(10);
    expect(dropRates(a.sample, [], null, 60_000).newConnPerSec).toBeNull();
  });

  it('reads cores and temperatures', () => {
    expect(coreLoads([{ cpu: 'cpu0', load: '12' }])).toBeNull();
    expect(coreLoads([{ cpu: 'cpu0', load: '12' }, { cpu: 'cpu1', load: '97' }])).toEqual({ cpu0: 12, cpu1: 97 });
    expect(temperatures([{ name: 'cpu-temperature', value: '57', type: 'C' }, { name: 'fan1-speed', value: '5220', type: 'RPM' },
      { name: 'switch-temperature', value: '41', type: 'C' }])).toEqual({ cpu_temperature: 57, switch_temperature: 41 });
    expect(temperatures([{ name: 'voltage', value: '23.6', type: 'V' }])).toBeNull();
  });

  it('reads link speeds', () => {
    expect(linkSpeedBps('10Gbps')).toBe(10e9);
    expect(linkSpeedBps('100Mbps')).toBe(100e6);
    expect(linkSpeedBps('2.5Gbps')).toBe(2.5e9);
    expect(linkSpeedBps('auto')).toBeNull();
  });
});
