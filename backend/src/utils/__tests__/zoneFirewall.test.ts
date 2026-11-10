import {
  parseZoneInput, compileZones, planApply, planMembers, zoneEligibility, zoneDrift, unzoned, signature, pairChain,
  addressError, ROUTER, type ZoneConfig, type ZonePolicy,
  endpointError, isHostname, zoneHosts, planHostLists, hostList, ZONE_HOST_COMMENT,
} from '../zoneFirewall';
import { evaluateInputChain, type MgmtConnection } from '../../services/changeGuard/firewallPath';
import { analyzeChange, type PlannedChange } from '../../services/changeGuard/analyzeChange';
import type { DeviceSnapshot, RosRow } from '../../services/changeGuard/pathModel';
import type { GuardDevice } from '../../services/changeGuard/ChangeGuard';

const live = { lists: ['LAN', 'WAN'], interfaces: ['bridge', 'ether1', 'ether2', 'ether5'] };
const ctx = { services: [{ name: 'ssh', port: '2222' }, { name: 'winbox', port: '8291' }], rosMajor: 7, fasttrackHwOffload: true, managerIp: '10.9.0.5' };

/** Ron's layout (#369): trust and untrust, trust can go out, trust manages the router. */
const POLICIES: Record<string, ZonePolicy> = {
  'LAN>WAN': { action: 'allow', services: [], custom: [] },
  'LAN>@router': { action: 'services', services: ['ping', 'ssh', 'winbox', 'dns'], custom: [{ protocol: 'tcp', ports: '2055' }] },
  'WAN>@router': { action: 'services', services: ['ping'], custom: [] },
};
const body = (over: Partial<ZoneConfig> = {}, members: Record<string, string[]> = { LAN: ['bridge'], WAN: ['ether1'] }) => ({
  config: {
    zones: ['LAN', 'WAN'],
    intra: { LAN: true, WAN: false },
    policies: POLICIES,
    fasttrack: true, logDrops: true, ...over,
  },
  members,
});

const DEFCONF: RosRow[] = [
  { '.id': '*0', chain: 'forward', action: 'passthrough', dynamic: 'true', comment: 'special dummy rule to show fasttrack counters' },
  { '.id': '*1', chain: 'input', action: 'accept', 'connection-state': 'established,related,untracked', comment: 'defconf: accept established,related,untracked' },
  { '.id': '*2', chain: 'input', action: 'drop', 'connection-state': 'invalid', comment: 'defconf: drop invalid' },
  { '.id': '*3', chain: 'input', action: 'drop', 'in-interface-list': '!LAN', comment: 'defconf: drop all not coming from LAN' },
];

describe('zone input (#369)', () => {
  it('reads a matrix and keeps only what is open', () => {
    const { input, errors } = parseZoneInput(body(), live);
    expect(errors).toEqual({});
    expect(Object.keys(input!.config.policies).sort()).toEqual(['LAN>@router', 'LAN>WAN', 'WAN>@router']);
    expect(input!.config.intra).toEqual({ LAN: true, WAN: false });
  });

  it('refuses what RouterOS or the matrix would get wrong', () => {
    const bad = (over: Partial<ZoneConfig>, members?: Record<string, string[]>) => parseZoneInput(body(over, members), live).errors;
    expect(bad({ zones: [] }).zones).toMatch(/at least one/);
    expect(bad({ zones: ['all'] })['zone:all']).toMatch(/RouterOS's own/);
    expect(bad({ zones: ['router'] })['zone:router']).toMatch(/kept/);
    expect(bad({ zones: ['a b', 'a_b'] })['zone:a_b']).toMatch(/too alike/);
    expect(bad({ policies: { 'LAN>WAN': { action: 'services', services: [], custom: [] } } })['pair:LAN>WAN']).toMatch(/at least one service/);
    expect(bad({ policies: { 'LAN>WAN': { action: 'services', services: [], custom: [{ protocol: 'tcp', ports: '70000' }] } } })['pair:LAN>WAN']).toMatch(/valid port/);
    expect(bad({}, { LAN: ['bridge'], WAN: ['bridge'] }).members).toMatch(/both LAN and WAN/);
    expect(bad({}, { LAN: ['nope'], WAN: [] })['zone:LAN']).toMatch(/isn't an interface/);
  });
});

describe('custom rules with addresses (#369 follow-up)', () => {
  const pair = (custom: unknown[]) => body({ policies: { 'WAN>LAN': { action: 'services', services: [], custom } as ZonePolicy } });

  it('takes a source and destination, with or without ports', () => {
    const { input, errors } = parseZoneInput(pair([
      { protocol: 'tcp', ports: '443', src: '203.0.113.7', dst: '192.168.88.10' },
      { protocol: 'any', ports: '', src: '198.51.100.0/24' },
      { protocol: 'udp', ports: '', dst: '192.168.88.20-192.168.88.30' },
    ]), live);
    expect(errors).toEqual({});
    const rules = compileZones(input!.config, ctx).filter((r) => r.params.chain === pairChain('WAN', 'LAN') && r.params.action === 'accept');
    expect(rules.map((r) => r.params)).toEqual([
      expect.objectContaining({ protocol: 'tcp', 'dst-port': '443', 'src-address': '203.0.113.7', 'dst-address': '192.168.88.10' }),
      expect.not.objectContaining({ protocol: expect.anything() }),
      expect.objectContaining({ protocol: 'udp', 'dst-address': '192.168.88.20-192.168.88.30' }),
    ]);
    expect(rules[1].params['src-address']).toBe('198.51.100.0/24');
    expect(rules[1].params['dst-port']).toBeUndefined();
    expect(rules[0].description).toBe('WAN to LAN: TCP 443 from 203.0.113.7 to 192.168.88.10');
  });

  it('writes a ports-only rule exactly as before, so saved setups don\'t drift', () => {
    const { input } = parseZoneInput(body(), live);
    const r = compileZones(input!.config, ctx).find((x) => x.params['dst-port'] === '2055')!;
    expect(r.params).toEqual(expect.objectContaining({ protocol: 'tcp', 'dst-port': '2055', comment: 'mtm zone: LAN to router: tcp 2055' }));
    expect(r.params['src-address']).toBeUndefined();
  });

  it('refuses what RouterOS would', () => {
    const err = (c: unknown) => parseZoneInput(pair([c]), live).errors['pair:WAN>LAN'];
    expect(err({ protocol: 'any', ports: '80' })).toMatch(/TCP or UDP/);
    expect(err({ protocol: 'tcp', ports: '', src: '10.0.0.300' })).toMatch(/isn't an IPv4 address/);
    expect(err({ protocol: 'tcp', ports: '', dst: '10.0.0.0/33' })).toMatch(/prefix length/);
    expect(err({ protocol: 'tcp', ports: '', src: '10.0.0.9-10.0.0.1' })).toMatch(/backwards/);
    expect(addressError('10.0.0.0/8')).toBeNull();
  });
});

describe('ICMP and protocol numbers in custom rules (#369)', () => {
  const pair = (custom: unknown[]) => body({ policies: { 'WAN>@router': { action: 'services', services: [], custom } as ZonePolicy } });
  const compiled = (custom: unknown[]) => {
    const { input, errors } = parseZoneInput(pair(custom), live);
    expect(errors).toEqual({});
    return compileZones(input!.config, ctx).filter((r) => r.params.chain === pairChain('WAN', ROUTER) && r.params.action === 'accept');
  };

  it('writes ICMP with or without a type, and OSPF by RouterOS\'s name', () => {
    const rules = compiled([
      { protocol: 'icmp', ports: '', icmp: '8' },
      { protocol: 'icmp', ports: '', icmp: '3:4', src: '203.0.113.0/24' },
      { protocol: 'icmp', ports: '' },
      { protocol: 'other', ports: '', number: '89' },
      { protocol: 'other', ports: '', number: '200', dst: '10.0.0.1' },
    ]);
    expect(rules.map((r) => r.params)).toEqual([
      expect.objectContaining({ protocol: 'icmp', 'icmp-options': '8', comment: 'mtm zone: WAN to router: icmp type 8' }),
      expect.objectContaining({ protocol: 'icmp', 'icmp-options': '3:4', 'src-address': '203.0.113.0/24' }),
      expect.not.objectContaining({ 'icmp-options': expect.anything() }),
      expect.objectContaining({ protocol: 'ospf', comment: 'mtm zone: WAN to router: ospf' }),
      expect.objectContaining({ protocol: '200', 'dst-address': '10.0.0.1', comment: 'mtm zone: WAN to router: protocol 200 to 10.0.0.1' }),
    ]);
    expect(rules[3].description).toBe('WAN to router: OSPF');
    expect(rules.every((r) => r.params['dst-port'] === undefined)).toBe(true);
  });

  it('takes 1, 6 and 17 as ICMP, TCP and UDP', () => {
    const rules = compiled([{ protocol: 'other', ports: '', number: '6', dst: '10.0.0.1' }, { protocol: 'other', ports: '53', number: '17' }]);
    expect(rules[0].params).toEqual(expect.objectContaining({ protocol: 'tcp', comment: 'mtm zone: WAN to router: tcp to 10.0.0.1' }));
    expect(rules[1].params).toEqual(expect.objectContaining({ protocol: 'udp', 'dst-port': '53' }));
  });

  it('refuses what RouterOS would', () => {
    const err = (c: unknown) => parseZoneInput(pair([c]), live).errors['pair:WAN>@router'];
    expect(err({ protocol: 'other', ports: '' })).toMatch(/Enter an IP protocol number/);
    expect(err({ protocol: 'other', ports: '', number: '300' })).toMatch(/"300" isn't an IP protocol number/);
    expect(err({ protocol: 'other', ports: '80', number: '89' })).toMatch(/TCP or UDP/);
    expect(err({ protocol: 'icmp', ports: '', icmp: '256' })).toMatch(/isn't an ICMP type/);
    expect(err({ protocol: 'icmp', ports: '', icmp: '3:9-4' })).toMatch(/isn't an ICMP type/);
    expect(err({ protocol: 'icmp', ports: '', icmp: '3:0-15' })).toBeUndefined();
  });

  it('sees no drift in how RouterOS prints them back', () => {
    // RouterOS 7.25 prints protocol=89 as ospf and keeps icmp-options as set.
    const want = { chain: 'x', action: 'accept', protocol: 'ospf', comment: 'c' };
    expect(signature({ ...want, protocol: '89' })).toBe(signature(want));
    expect(signature({ ...want, protocol: 'tcp' })).toBe(signature({ ...want, protocol: '6' }));
    const icmp = { chain: 'x', action: 'accept', protocol: 'icmp', 'icmp-options': '8', comment: 'c' };
    expect(signature({ ...icmp, 'icmp-options': '8:0-255' })).toBe(signature(icmp));
    expect(signature({ ...icmp, 'icmp-options': '8:0' })).not.toBe(signature(icmp));
  });
});

describe('hostnames in custom rules (#369)', () => {
  const pair = (custom: unknown[]) => body({ policies: { 'LAN>WAN': { action: 'services', services: [], custom } as ZonePolicy } });

  it('tells a hostname from an address', () => {
    expect(isHostname('smtp.office365.com')).toBe(true);
    expect(isHostname('SMTP.Outlook.com')).toBe(true);
    for (const v of ['10.0.0.1', '10.0.0.0/24', '10.0.0.1-10.0.0.9', 'localhost', 'bad_name.com', '-a.com', 'a.123']) expect(isHostname(v)).toBe(false);
    expect(endpointError('smtp.outlook.com')).toBeNull();
    expect(endpointError('10.0.0.300')).toMatch(/isn't an IPv4 address/);
    expect(endpointError('not a host')).toMatch(/or a hostname/);
  });

  it('matches a hostname through an address list named after it (Ron: trust to untrust, SMTP to smtp.outlook.com)', () => {
    const { input, errors } = parseZoneInput(pair([{ protocol: 'tcp', ports: '587', dst: 'SMTP.Outlook.com' }]), live);
    expect(errors).toEqual({});
    expect(input!.config.policies['LAN>WAN'].custom[0].dst).toBe('smtp.outlook.com');
    const rule = compileZones(input!.config, ctx).find((r) => r.params['dst-port'] === '587')!;
    expect(rule.params).toEqual(expect.objectContaining({
      protocol: 'tcp', 'dst-address-list': 'mtm-zone-smtp.outlook.com', comment: 'mtm zone: LAN to WAN: tcp 587 to smtp.outlook.com',
    }));
    expect(rule.params['dst-address']).toBeUndefined();
    expect(zoneHosts(input!.config)).toEqual(['smtp.outlook.com']);
  });

  it('keeps one entry per hostname, and removes the ones no rule uses', () => {
    const current = [
      { '.id': '*1', list: hostList('smtp.outlook.com'), address: 'smtp.outlook.com', comment: ZONE_HOST_COMMENT },
      { '.id': '*2', list: hostList('old.example.com'), address: 'old.example.com', comment: ZONE_HOST_COMMENT },
      { '.id': '*3', list: hostList('smtp.outlook.com'), address: 'smtp.outlook.com', comment: ZONE_HOST_COMMENT },
    ];
    expect(planHostLists(current, ['smtp.outlook.com', 'api.example.org'])).toEqual({
      add: [{ list: 'mtm-zone-api.example.org', address: 'api.example.org', comment: ZONE_HOST_COMMENT }],
      remove: [{ id: '*2', list: 'mtm-zone-old.example.com' }, { id: '*3', list: 'mtm-zone-smtp.outlook.com' }],
    });
    expect(planHostLists([], [])).toEqual({ add: [], remove: [] });
  });

  it('sees a changed list on the device as a different rule', () => {
    const want = { chain: 'x', action: 'accept', 'dst-address-list': 'mtm-zone-a.com', comment: 'c' };
    expect(signature({ ...want, 'dst-address-list': 'mtm-zone-b.com' })).not.toBe(signature(want));
    expect(signature({ '.id': '*9', ...want })).toBe(signature(want));
  });
});

describe('compiling zones', () => {
  const { input } = parseZoneInput(body(), live);
  const rules = compileZones(input!.config, ctx);
  const by = (chain: string) => rules.filter((r) => r.params.chain === chain).map((r) => r.params);

  it('builds Ron\'s layout: stateful rules, same-zone accepts, a jump per open pair, drops at the end', () => {
    expect(by('input').map((r) => r.action)).toEqual(['accept', 'drop', 'accept', 'accept', 'jump', 'jump', 'drop']);
    expect(by('input')[3]['src-address']).toBe('10.9.0.5');
    expect(by('input')[4]).toMatchObject({ 'jump-target': 'LAN-to-router', 'in-interface-list': 'LAN' });
    expect(by('forward').map((r) => r.action)).toEqual(['fasttrack-connection', 'accept', 'drop', 'accept', 'jump', 'drop']);
    expect(by('forward')[0]['hw-offload']).toBe('yes');
    expect(by('forward')[3]).toMatchObject({ 'in-interface-list': 'LAN', 'out-interface-list': 'LAN' });
    expect(by('forward')[4]).toMatchObject({ 'jump-target': 'LAN-to-WAN', 'in-interface-list': 'LAN', 'out-interface-list': 'WAN' });
    expect(by('forward').at(-1)).toMatchObject({ action: 'drop', log: 'yes', 'log-prefix': 'zone drop fwd' });
  });

  it('puts each pair\'s services in its own chain, on the device\'s ports, ending in a hidden return', () => {
    const chain = rules.filter((r) => r.params.chain === 'LAN-to-router');
    expect(chain.map((r) => [r.params.protocol, r.params['dst-port']])).toEqual([
      ['icmp', undefined], ['tcp', '2222'], ['tcp', '8291'], ['udp', '53'], ['tcp', '53'], ['tcp', '2055'], [undefined, undefined],
    ]);
    expect(chain.at(-1)!.hidden).toBe(true);
    expect(rules.filter((r) => r.params.chain === 'LAN-to-WAN').map((r) => r.params.action)).toEqual(['accept', 'return']);
    expect(rules.filter((r) => r.hidden).map((r) => r.params.action).sort()).toEqual(['drop', 'drop', 'return', 'return', 'return']);
    expect(rules.every((r) => r.params.comment.startsWith('mtm zone: '))).toBe(true);
  });

  it('names chains safely', () => {
    expect(pairChain('Guest Wi-Fi', ROUTER)).toBe('Guest_Wi_Fi-to-router');
    expect(pairChain('LAN', 'DMZ')).toBe('LAN-to-DMZ');
  });

  it('leaves out FastTrack, hw-offload on v6, logging and the manager rule when asked or unknown', () => {
    const plain = compileZones({ ...input!.config, logDrops: false }, { ...ctx, managerIp: null, rosMajor: 6 });
    expect(plain.some((r) => r.params['src-address'])).toBe(false);
    expect(plain.find((r) => r.params.action === 'fasttrack-connection')!.params['hw-offload']).toBeUndefined();
    // A RouterOS 7 build that doesn't take hw-offload refuses the whole change (#369).
    const noHw = compileZones(input!.config, { ...ctx, fasttrackHwOffload: false });
    expect(noHw.find((r) => r.params.action === 'fasttrack-connection')!.params['hw-offload']).toBeUndefined();
    expect(plain.filter((r) => r.params.log)).toEqual([]);
    const noFt = compileZones({ ...input!.config, fasttrack: false }, ctx);
    expect(noFt.some((r) => r.params.action === 'fasttrack-connection')).toBe(false);
  });
});

describe('applying zones to the device', () => {
  const { input } = parseZoneInput(body(), live);
  const desired = compileZones(input!.config, ctx);

  it('starts from defaults or an empty table only', () => {
    expect(zoneEligibility(DEFCONF)).toEqual({ ok: true, foreign: 0 });
    expect(zoneEligibility([...DEFCONF, { '.id': '*9', chain: 'input', action: 'accept', comment: 'my rule' }])).toEqual({ ok: false, foreign: 1 });
    expect(zoneEligibility([{ '.id': '*9', chain: 'input', action: 'accept', comment: 'mtm zone: LAN to router' }]).ok).toBe(true);
  });

  it('keeps defaults that are already right, removes the rest, and tags the logging drops', () => {
    const plan = planApply(DEFCONF, desired);
    // The two stateful input rules match except for their comments, so they're replaced too.
    expect(plan.keep).toBe(0);
    expect(plan.remove.map((r) => r.id)).toEqual(['*3', '*2', '*1']);
    expect(plan.add).toHaveLength(desired.length);
    const drops = plan.add.filter((a) => a.params.log === 'yes');
    expect(drops.map((d) => d.params['log-prefix'])).toEqual([expect.stringMatching(/^zone drop in mtm#[0-9a-z]{4}$/), expect.stringMatching(/^zone drop fwd mtm#[0-9a-z]{4}$/)]);
  });

  it('changes only what differs on a second apply, keeping counters and tags', () => {
    // The device after the first apply, as RouterOS prints it.
    const first: RosRow[] = planApply([], desired).add.map((a, i) => ({ '.id': `*${(i + 16).toString(16).toUpperCase()}`, ...a.params, bytes: '100', packets: '1', log: a.params.log ?? 'false', disabled: 'false', invalid: 'false', dynamic: 'false' }));
    expect(zoneDrift(first, desired)).toBeNull();
    expect(planApply(first, desired)).toMatchObject({ add: [], remove: [], keep: desired.length });

    // Open WAN to the router for SSH as well: one rule, placed before the chain's return.
    const more = parseZoneInput(body({ policies: { ...POLICIES, 'WAN>@router': { action: 'services', services: ['ping', 'ssh'], custom: [] } } }), live).input!;
    const plan = planApply(first, compileZones(more.config, ctx));
    expect(plan.remove).toEqual([]);
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0].params).toMatchObject({ chain: 'WAN-to-router', protocol: 'tcp', 'dst-port': '2222' });
    const ret = first.find((r) => r.chain === 'WAN-to-router' && r.action === 'return')!;
    expect(plan.add[0].placeBefore).toBe(ret['.id']);
  });

  it('reports a hand edit as drift', () => {
    const onDevice: RosRow[] = planApply([], desired).add.map((a, i) => ({ '.id': `*${i + 1}`, ...a.params }));
    onDevice.splice(2, 0, { '.id': '*99', chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '23', comment: 'telnet' });
    const edited = onDevice.map((r) => (r['jump-target'] === 'LAN-to-WAN' ? { ...r, disabled: 'true' } : r));
    expect(zoneDrift(edited, desired)).toEqual({ missing: ['LAN to WAN'], extra: ['mtm zone: LAN to WAN', 'telnet'] });
  });

  it('treats the tag and RouterOS\'s print defaults as the same rule', () => {
    const want = { chain: 'input', action: 'drop', log: 'yes', 'log-prefix': 'zone drop in', comment: 'x' };
    expect(signature({ '.id': '*1', ...want, 'log-prefix': 'zone drop in mtm#ab12', disabled: 'false', invalid: 'false', bytes: '5' })).toBe(signature(want));
    expect(signature({ ...want, 'src-address-list': 'bad' })).not.toBe(signature(want));
  });

  it('plans list members and spots addressed interfaces in no zone', () => {
    const members: RosRow[] = [
      { '.id': '*1', list: 'LAN', interface: 'bridge' },
      { '.id': '*2', list: 'LAN', interface: 'ether5' },
      { '.id': '*3', list: 'WAN', interface: 'lte1', dynamic: 'true' },
    ];
    expect(planMembers(['LAN', 'WAN'], members, { LAN: ['bridge'], WAN: ['ether1'], DMZ: ['ether2'] })).toEqual({
      createLists: ['DMZ'],
      addMembers: [{ list: 'WAN', interface: 'ether1' }, { list: 'DMZ', interface: 'ether2' }],
      removeMembers: [{ id: '*2', list: 'LAN', interface: 'ether5' }],
    });
    const addrs: RosRow[] = [{ address: '192.168.88.1/24', interface: 'bridge' }, { address: '10.0.0.1/24', interface: 'ether5' }, { address: '1.2.3.4/24', interface: 'ether1', disabled: 'true' }];
    expect(unzoned(addrs, { LAN: ['bridge'] })).toEqual(['ether5']);
  });
});

describe('Change Guard on a zone apply', () => {
  const device: GuardDevice = { id: 1, name: 'r1', ip_address: '192.168.0.40', api_port: 8728, api_username: 'admin', api_password_encrypted: 'x', jump_host_id: null };
  const conn: MgmtConnection = { srcIp: '10.9.0.5', dstIp: '192.168.0.40', dstPort: 8728, inInterface: 'bridge' };
  const snap = (filter: RosRow[]): DeviceSnapshot => ({
    addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' }],
    interfaces: [{ name: 'bridge', type: 'bridge', disabled: 'false' }, { name: 'ether1', type: 'ether', disabled: 'false' }, { name: 'ether2', type: 'ether', disabled: 'false' }],
    vlanInterfaces: [], bridges: [{ name: 'bridge', 'vlan-filtering': 'false', pvid: '1' }],
    bridgePorts: [{ interface: 'ether2', bridge: 'bridge', pvid: '1', disabled: 'false' }], bridgeVlans: [], bonds: [],
    routes: [{ '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: '192.168.0.1', active: 'true' }],
    arp: [{ address: '192.168.0.1', 'mac-address': 'AA:BB:CC:00:00:01', interface: 'bridge' }],
    bridgeHosts: [{ 'mac-address': 'AA:BB:CC:00:00:01', 'on-interface': 'ether2', local: 'false' }],
    services: [{ '.id': '*1', name: 'api', port: '8728', disabled: 'false' }],
    firewallFilter: filter,
    mgmtConnections: [{ protocol: 'tcp', 'src-address': '10.9.0.5:51000', 'dst-address': '192.168.0.40:8728' }],
    interfaceLists: [{ name: 'LAN' }, { name: 'WAN' }],
    interfaceListMembers: [{ '.id': '*M1', list: 'LAN', interface: 'bridge', disabled: 'false' }, { '.id': '*M2', list: 'WAN', interface: 'ether1', disabled: 'false' }],
    addressLists: [], addressListsRead: [],
  });
  const batch = (config: ZoneConfig, managerIp: string | null, extra: PlannedChange[] = []): PlannedChange => {
    const plan = planApply(DEFCONF, compileZones(config, { ...ctx, managerIp }));
    return { kind: 'batch', changes: [
      ...extra,
      ...plan.add.map((a): PlannedChange => ({ kind: 'firewall.add', fields: a.params, ...(a.placeBefore ? { placeBefore: a.placeBefore } : {}) })),
      ...plan.remove.map((r): PlannedChange => ({ kind: 'firewall.remove', ruleId: r.id })),
    ] };
  };
  const { input } = parseZoneInput(body(), live);

  it('follows the jump into the zone\'s chain and sees the manager let in', () => {
    const rules = planApply([], compileZones(input!.config, { ...ctx, managerIp: null })).add.map((a, i) => ({ '.id': `*${i + 1}`, ...a.params }));
    // LAN to router allows Winbox and SSH but not the API port, so only the final drop decides.
    expect(evaluateInputChain(snap(rules), conn).outcome).toBe('dropped');
    const withApi = parseZoneInput(body({ policies: { ...POLICIES, 'LAN>@router': { action: 'allow', services: [], custom: [] } } }), live).input!;
    const open = planApply([], compileZones(withApi.config, { ...ctx, managerIp: null })).add.map((a, i) => ({ '.id': `*${i + 1}`, ...a.params }));
    expect(evaluateInputChain(snap(open), conn).outcome).toBe('accepted');
  });

  it('passes an apply that keeps the manager rule, and stops one that would lock it out', () => {
    expect(analyzeChange(snap(DEFCONF), device, batch(input!.config, '10.9.0.5')).severity).not.toBe('critical');
    expect(analyzeChange(snap(DEFCONF), device, batch(input!.config, null)).severity).toBe('critical');
  });

  it('limits the manager to the API, API-SSL and SSH ports when asked, and still lets it in (#369)', () => {
    const { input: limited } = parseZoneInput(body({ managerAccess: 'management' }), live);
    expect(limited!.config.managerAccess).toBe('management');
    expect(parseZoneInput(body(), live).input!.config).not.toHaveProperty('managerAccess');
    const rules = compileZones(limited!.config, { ...ctx, managerIp: '10.9.0.5' });
    // SSH is on 2222 on this device (ctx.services).
    expect(rules.find((r) => r.params['src-address'] === '10.9.0.5')!.params).toEqual(expect.objectContaining({
      chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '8728,8729,2222', comment: 'mtm zone: accept the manager on 8728,8729,2222',
    }));
    expect(analyzeChange(snap(DEFCONF), device, batch(limited!.config, '10.9.0.5')).severity).not.toBe('critical');
    const onDevice = planApply([], rules).add.map((a, i) => ({ '.id': `*${i + 1}`, ...a.params }));
    expect(evaluateInputChain(snap(onDevice), conn).outcome).toBe('accepted');
    expect(evaluateInputChain(snap(onDevice), { ...conn, dstPort: 80 }).outcome).toBe('dropped');
  });

  it('sees a membership change move the management interface out of its zone', () => {
    const withApi = parseZoneInput(body({ policies: { 'LAN>@router': { action: 'allow', services: [], custom: [] } } }), live).input!;
    expect(analyzeChange(snap(DEFCONF), device, batch(withApi.config, null)).severity).not.toBe('critical');
    const moved = batch(withApi.config, null, [{ kind: 'interface-list.member.remove', memberId: '*M1' }]);
    expect(analyzeChange(snap(DEFCONF), device, moved).severity).toBe('critical');
  });
});
