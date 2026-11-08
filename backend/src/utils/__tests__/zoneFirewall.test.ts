import {
  parseZoneInput, compileZones, planApply, planMembers, zoneEligibility, zoneDrift, unzoned, signature, pairChain,
  ROUTER, type ZoneConfig, type ZonePolicy,
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

  it('sees a membership change move the management interface out of its zone', () => {
    const withApi = parseZoneInput(body({ policies: { 'LAN>@router': { action: 'allow', services: [], custom: [] } } }), live).input!;
    expect(analyzeChange(snap(DEFCONF), device, batch(withApi.config, null)).severity).not.toBe('critical');
    const moved = batch(withApi.config, null, [{ kind: 'interface-list.member.remove', memberId: '*M1' }]);
    expect(analyzeChange(snap(DEFCONF), device, moved).severity).toBe('critical');
  });
});
