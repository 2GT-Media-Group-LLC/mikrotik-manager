import { planPreset, findEquivalent, topAnchor, presetNeeds, type QuickContext } from '../firewallPresets';

const ctx = (over: Partial<QuickContext> = {}): QuickContext => ({
  family: 'ip', filter: [], nat: [], addressLists: [], interfaceLists: ['WAN', 'LAN', 'all'], interfaces: ['ether1', 'bridge'],
  services: [{ name: 'winbox', port: '8291', disabled: 'false' }, { name: 'ssh', port: '22', disabled: 'false' },
    { name: 'api', port: '8728', disabled: 'true' }, { name: 'api-ssl', port: '8729', disabled: 'false' },
    { name: 'www', port: '80', disabled: 'true' }, { name: 'www-ssl', port: '443', disabled: 'false' }],
  managerIp: '192.168.0.10', rosMajor: 7, ...over,
});
const LAN = { kind: 'list' as const, name: 'LAN' };
const WAN = { kind: 'list' as const, name: 'WAN' };

describe('quick firewall presets (#330)', () => {
  it('input basics: defconf, accepts on top, the catch-all drop at the end', () => {
    const p = planPreset('input-basics', { lan: LAN }, ctx());
    expect(p.errors).toEqual({});
    expect(p.steps.map((s) => [s.placement, s.params.action, s.params['connection-state'] ?? s.params.protocol ?? s.params['dst-address'] ?? s.params['in-interface-list']]))
      .toEqual([['top', 'accept', 'established,related,untracked'], ['top', 'drop', 'invalid'], ['top', 'accept', 'icmp'],
        ['top', 'accept', '127.0.0.1'], ['bottom', 'drop', '!LAN']]);
    expect(p.steps.every((s) => s.skip === null)).toBe(true);
  });

  it('skips a rule that is already there, whatever its comment or order of states', () => {
    const filter = [{ '.id': '*1', chain: 'input', action: 'accept', 'connection-state': 'untracked,established,related', comment: 'defconf: accept established,related,untracked' }];
    const p = planPreset('input-basics', { lan: LAN }, ctx({ filter }));
    expect(p.steps[0].skip).toMatch(/Already there/);
    // Just added (RouterOS shows it invalid for a moment) still counts.
    expect(planPreset('input-basics', { lan: LAN }, ctx({ filter: [{ ...filter[0], invalid: 'true' }] })).steps[0].skip).toMatch(/Already there/);
    // Disabled doesn't count.
    expect(planPreset('input-basics', { lan: LAN }, ctx({ filter: [{ ...filter[0], disabled: 'true' }] })).steps[0].skip).toBeNull();
    // An extra matcher makes it a different rule.
    expect(findEquivalent([{ ...filter[0], 'in-interface': 'ether1' }], { chain: 'input', action: 'accept', 'connection-state': 'established,related,untracked' })).toBeUndefined();
  });

  it('uses an interface when that is what was chosen', () => {
    const p = planPreset('input-basics', { lan: { kind: 'interface', name: 'bridge' } }, ctx());
    expect(p.steps[p.steps.length - 1].params).toMatchObject({ 'in-interface': '!bridge' });
    expect(planPreset('input-basics', { lan: { kind: 'list', name: 'NOPE' } }, ctx()).errors.lan).toMatch(/NOPE/);
    expect(planPreset('input-basics', {}, ctx()).errors.lan).toMatch(/Choose the LAN/);
  });

  it('forward basics, with FastTrack and IPsec accepted first', () => {
    const p = planPreset('forward-basics', { wan: WAN, fasttrack: true }, ctx());
    expect(p.steps.map((s) => s.params.action)).toEqual(['accept', 'accept', 'fasttrack-connection', 'accept', 'drop', 'drop']);
    expect(p.steps[2].params['hw-offload']).toBe('yes');
    expect(p.steps[5]).toMatchObject({ placement: 'bottom', params: expect.objectContaining({ 'connection-nat-state': '!dstnat', 'in-interface-list': 'WAN' }) });
    expect(planPreset('forward-basics', { wan: WAN, fasttrack: true }, ctx({ rosMajor: 6 })).steps[2].params['hw-offload']).toBeUndefined();
    expect(planPreset('forward-basics', { wan: WAN }, ctx()).steps).toHaveLength(3);
  });

  it('management access: the manager\'s address first, only enabled services, accept before drop', () => {
    const p = planPreset('management-access', {}, ctx());
    expect(p.steps.map((s) => s.table)).toEqual(['address-list', 'filter', 'filter']);
    expect(p.steps[0].params).toMatchObject({ list: 'mtm-management', address: '192.168.0.10' });
    expect(p.steps[1].params).toMatchObject({ action: 'accept', 'dst-port': '22,443,8291,8729', 'src-address-list': 'mtm-management' });
    expect(p.steps[2].params).toMatchObject({ action: 'drop', 'dst-port': '22,443,8291,8729' });
    expect(p.steps[2].params['src-address-list']).toBeUndefined();
  });

  it('management access refuses what it can\'t check, and needs someone in the list', () => {
    expect(planPreset('management-access', { addresses: ['10.0.0.0/33', 'nas'] }, ctx()).errors.addresses).toMatch(/10.0.0.0\/33, nas/);
    expect(planPreset('management-access', { services: ['api', 'www'] }, ctx()).errors.services).toMatch(/None of the chosen/);
    expect(planPreset('management-access', {}, ctx({ managerIp: null })).errors.addresses).toMatch(/couldn't see its own address/);
    const p = planPreset('management-access', { addresses: ['10.10.0.0/24'] }, ctx({ managerIp: null, addressLists: [{ list: 'mtm-management', address: '10.10.0.0/24' }] }));
    expect(p.steps[0].skip).toMatch(/already in/);
  });

  it('masquerade, and the IPv6 presets', () => {
    expect(planPreset('masquerade', { wan: WAN }, ctx()).steps[0]).toMatchObject({ table: 'nat', placement: 'bottom', params: expect.objectContaining({ action: 'masquerade', 'out-interface-list': 'WAN' }) });
    const v6 = planPreset('input-basics', { lan: LAN }, ctx({ family: 'ipv6' }));
    expect(v6.steps.map((s) => s.params.protocol ?? '')).toContain('icmpv6');
    expect(v6.steps.some((s) => s.params['dst-port'] === '546')).toBe(true);
    expect(planPreset('masquerade', { wan: WAN }, ctx({ family: 'ipv6' })).errors.preset).toMatch(/IPv4/);
    expect(presetNeeds('forward-basics', 'ipv6')).toEqual({ wan: false, lan: true });
  });

  it('puts top rules before the first configured rule, past dynamic ones', () => {
    expect(topAnchor([{ '.id': '*0', dynamic: 'true' }, { '.id': '*5' }])).toBe('*5');
    expect(topAnchor([])).toBeNull();
  });
});
