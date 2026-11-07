import {
  conntrackActive, conntrackFields, dropRules, dropRates, chainField, coreLoads, temperatures, linkSpeedBps,
  pickBusiest, ifaceSpeed, ifaceOrder, type GraphIface,
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

  const iface = (name: string, over: Partial<GraphIface> = {}): GraphIface =>
    ({ name, type: 'ether', running: true, speedBps: 10e9, members: [], parent: null, ...over });
  const ifs = new Map([
    iface('sfp-sfpplus1'), iface('sfp-sfpplus2'), iface('ether40', { speedBps: 1e9 }), iface('sfp-sfpplus12'),
    iface('Po1', { type: 'bond', speedBps: null, members: ['sfp-sfpplus1', 'sfp-sfpplus2'] }),
    iface('pppoe-out1', { type: 'pppoe-out', speedBps: null, parent: 'sfp-sfpplus12' }),
    iface('vlan10', { type: 'vlan', parent: 'sfp-sfpplus1' }),
  ].map((i) => [i.name, i]));

  it('never picks two interfaces that carry the same traffic (aziz, #402)', () => {
    const totals = new Map([['Po1', 900], ['sfp-sfpplus1', 500], ['sfp-sfpplus2', 400], ['ether40', 50],
      ['sfp-sfpplus12', 300], ['pppoe-out1', 290], ['vlan10', 800]]);
    expect(pickBusiest(totals, ifs)).toEqual(['Po1', 'pppoe-out1', 'ether40']);
  });

  it('leaves out VRRP, which rides on a VLAN or port already counted (aziz, #402)', () => {
    const gw = new Map(ifs);
    gw.set('vrrp10', iface('vrrp10', { type: 'vrrp', speedBps: null }));
    gw.set('wg1', iface('wg1', { type: 'wg', speedBps: null }));
    const totals = new Map([['Po1', 900], ['pppoe-out1', 600], ['vrrp10', 500], ['sfp-sfpplus12', 590], ['wg1', 20]]);
    expect(pickBusiest(totals, gw)).toEqual(['Po1', 'pppoe-out1', 'wg1']);
  });

  it('gives a bond its running members\' speed', () => {
    expect(ifaceSpeed(ifs.get('Po1')!, ifs)).toBe(20e9);
    const down = new Map(ifs);
    down.set('sfp-sfpplus2', iface('sfp-sfpplus2', { running: false }));
    expect(ifaceSpeed(ifs.get('Po1')!, down)).toBe(10e9);
    // A PPPoE client runs at its port's speed.
    expect(ifaceSpeed(ifs.get('pppoe-out1')!, ifs)).toBe(10e9);
    expect(ifaceSpeed(iface('wg1', { type: 'wg', speedBps: null }), ifs)).toBeNull();
  });

  it('sorts ports the way they are numbered', () => {
    const names = [['ether10', 'ether'], ['vlan10', 'vlan'], ['qsfpplus1-1', 'ether'], ['ether2', 'ether'], ['Po1', 'bond'],
      ['sfp-sfpplus2', 'ether'], ['ether1', 'ether'], ['bridge', 'bridge'], ['pppoe-out1', 'pppoe-out'], ['sfp-sfpplus10', 'ether']]
      .map(([name, type]) => ({ name, type }));
    expect(names.sort(ifaceOrder).map((x) => x.name)).toEqual(
      ['ether1', 'ether2', 'ether10', 'sfp-sfpplus2', 'sfp-sfpplus10', 'qsfpplus1-1', 'Po1', 'vlan10', 'pppoe-out1', 'bridge']);
  });
});
