import { buildPairs, pairMlag, mlagFindings, bondRows, buildPeerLink, peerLinkFindings, type MlagBridge, type MlagBond, type MlagEvents, type PortFacts } from '../mlag';

const bridge = (id: number, over: Partial<MlagBridge> = {}): MlagBridge => ({
  device_id: id, device_name: `CSW0${id}`, ros_version: '7.25', bridge_name: 'bridge', mlag_peer_port: 'Po15',
  mlag_priority: id === 1 ? 50 : 100, mlag_heartbeat: '5s', mlag_init_delay: '1m', mlag_lacp_fallback: true,
  mlag_state: 'connected', mlag_role: id === 1 ? 'primary' : 'secondary', mlag_state_changed_at: '2026-10-01T00:00:00Z',
  mlag_missing_vlans: [], ...over,
});
const peerLink = (id: number, over: Partial<MlagBond> = {}): MlagBond => ({
  device_id: id, bond: 'Po15', bridge: 'bridge', mlag_id: null, is_peer_link: true, slaves: 'sfp-sfpplus15,sfp-sfpplus16',
  running: true, active_ports: 'sfp-sfpplus15,sfp-sfpplus16', inactive_ports: null, partner_sys_id: null, ...over,
});
const mbond = (id: number, mlagId: number, over: Partial<MlagBond> = {}): MlagBond => ({
  device_id: id, bond: `Po${mlagId}`, bridge: 'bridge', mlag_id: mlagId, is_peer_link: false, slaves: `sfp-sfpplus${mlagId}`,
  running: true, active_ports: `sfp-sfpplus${mlagId}`, inactive_ports: null, partner_sys_id: 'D0:EA:11:EF:6C:02', ...over,
});
const links = [{ from_device_id: 1, from_interface: 'sfp-sfpplus15', to_device_id: 2 }, { from_device_id: 2, from_interface: 'sfp-sfpplus16', to_device_id: 1 }];
const NOW = Date.parse('2026-11-05T12:00:00Z');
const none = new Map<number, MlagEvents>();
const codes = (f: { code: string }[]) => f.map((x) => x.code);

describe('MLAG (#376)', () => {
  it('pairs the two peers from neighbour discovery on the peer link\'s members', () => {
    const pairs = pairMlag([bridge(1), bridge(2)], [peerLink(1), peerLink(2)], links);
    expect(pairs.map(([a, b]) => [a.device_id, b?.device_id])).toEqual([[1, 2]]);
    expect(pairMlag([bridge(1)], [peerLink(1)], [])).toEqual([[expect.objectContaining({ device_id: 1 }), null]]);
    // Discovery reported from the other end only.
    const oneWay = pairMlag([bridge(1), bridge(2)], [peerLink(1), peerLink(2)], [{ from_device_id: 2, from_interface: 'sfp-sfpplus16', to_device_id: 1 }]);
    expect(oneWay.map(([a, b]) => [a.device_id, b?.device_id])).toEqual([[1, 2]]);
  });

  it('a healthy pair has nothing to report', () => {
    const bonds = [peerLink(1), peerLink(2), mbond(1, 1), mbond(2, 1)];
    const [pair] = buildPairs([bridge(1), bridge(2)], bonds, links, none, NOW);
    expect(pair.findings).toEqual([]);
    expect(pair.status).toBe('healthy');
    expect(pair.bonds).toEqual([expect.objectContaining({ mlagId: 1, status: 'dual-homed' })]);
  });

  it('finds Aziz\'s single-homed bond, missing VLAN 1 and heartbeat storm', () => {
    const bonds = [peerLink(1), peerLink(2), mbond(1, 10, { partner_device_name: 'ASW08' }), mbond(2, 10, { running: false, active_ports: null, inactive_ports: 'sfp-sfpplus10' })];
    const events = new Map([[1, { heartbeatHour: 45, fdbFailHour: 120, peerLinkDownDay: 0 }]]);
    const f = mlagFindings(bridge(1, { mlag_missing_vlans: [1] }), bridge(2), bonds, events, NOW);
    expect(codes(f)).toEqual(['heartbeat', 'single-homed', 'vlans', 'fdb-sync']);
    expect(f[0]).toMatchObject({ severity: 'critical', text: 'CSW01: 45 MLAG heartbeat timeouts in the last hour.' });
    expect(f.find((x) => x.code === 'single-homed')!.text).toBe('mlag-id 10 (ASW08) is up on CSW01 only (Po10 is down on the other).');
    expect(f.find((x) => x.code === 'vlans')!.text).toContain('VLAN 1 is on MLAG bonds but not tagged on the peer link Po15');
  });

  it('calls out a split brain, a disconnected peer, a dead peer link and a miswired bond as critical', () => {
    const bonds = [peerLink(1, { running: false }), peerLink(2, { inactive_ports: 'sfp-sfpplus16', active_ports: 'sfp-sfpplus15' }),
      mbond(1, 3), mbond(2, 3, { partner_sys_id: 'AA:AA:AA:AA:AA:AA' })];
    const f = mlagFindings(bridge(1), bridge(2, { mlag_role: 'primary', mlag_state: 'disconnected' }), bonds, none, NOW);
    expect(f.filter((x) => x.severity === 'critical').map((x) => x.code).sort()).toEqual(['partner', 'peer-link', 'roles', 'state']);
    expect(f.find((x) => x.code === 'roles')!.text).toBe('Both peers are primary (split brain).');
    expect(f.find((x) => x.code === 'peer-link' && x.severity === 'warning')!.text).toBe('CSW02: the peer link Po15 has 1 of 2 members up (sfp-sfpplus16 not active).');
  });

  it('warns about settings that differ, a recent role change and peer-link flaps', () => {
    const f = mlagFindings(bridge(1, { mlag_heartbeat: '2s', mlag_state_changed_at: new Date(NOW - 3600_000).toISOString() }), bridge(2, { ros_version: '7.24.5' }),
      [peerLink(1), peerLink(2)], new Map([[2, { heartbeatHour: 0, fdbFailHour: 0, peerLinkDownDay: 3 }]]), NOW);
    expect(codes(f).sort()).toEqual(['changed', 'mismatch', 'mismatch', 'peer-link-flap']);
  });

  it('says when the peer isn\'t found, and checks what it can alone', () => {
    const f = mlagFindings(bridge(1, { mlag_state: 'disconnected' }), null, [peerLink(1)], none, NOW);
    expect(codes(f)).toEqual(['state', 'no-peer']);
  });

  it('lines the bonds up by mlag-id', () => {
    const rows = bondRows(bridge(1), bridge(2), [mbond(1, 1), mbond(2, 1), mbond(1, 2), mbond(2, 5, { running: false, last_running_at: '2026-11-01T00:00:00Z' })]);
    expect(rows.map((r) => [r.mlagId, r.status])).toEqual([[1, 'dual-homed'], [2, 'single-homed'], [5, 'down']]);
  });

  it('a bond down on both peers that was never up is unused, not down', () => {
    const spare = { running: false, active_ports: null, inactive_ports: 'sfp-sfpplus11', partner_sys_id: null };
    const bonds = [peerLink(1), peerLink(2), mbond(1, 11, spare), mbond(2, 11, spare)];
    const [pair] = buildPairs([bridge(1), bridge(2)], bonds, links, none, NOW);
    expect(pair.bonds[0].status).toBe('unused');
    expect(pair.findings).toEqual([]);
    expect(pair.status).toBe('healthy');
    // One that was up and went down stays down, and says so.
    const was = [peerLink(1), peerLink(2), mbond(1, 11, { ...spare, last_running_at: '2026-11-04T00:00:00Z' }), mbond(2, 11, spare)];
    const [p2] = buildPairs([bridge(1), bridge(2)], was, links, none, NOW);
    expect(p2.bonds[0].status).toBe('down');
    expect(p2.findings).toEqual([expect.objectContaining({ code: 'bond-down', severity: 'warning', text: 'mlag-id 11 is down on both peers.' })]);
    expect(p2.status).toBe('warning');
  });

  it('puts the primary on the left whichever was added first, else orders by name', () => {
    const wsw = (id: number, name: string, role: string) => bridge(id, { device_name: name, mlag_role: role });
    const l = [{ from_device_id: 3, from_interface: 'sfp-sfpplus15', to_device_id: 4 }];
    const pairs = pairMlag([wsw(3, 'WSW02', 'secondary'), wsw(4, 'WSW01', 'primary')], [peerLink(3), peerLink(4)], l);
    expect(pairs.map(([a, b]) => [a.device_name, b?.device_name])).toEqual([['WSW01', 'WSW02']]);
    const unknown = pairMlag([wsw(3, 'WSW02', ''), wsw(4, 'WSW01', '')], [peerLink(3), peerLink(4)], l);
    expect(unknown.map(([a, b]) => [a.device_name, b?.device_name])).toEqual([['WSW01', 'WSW02']]);
  });

  it('a pair with only warnings is a warning, not degraded', () => {
    const [pair] = buildPairs([bridge(1, { mlag_heartbeat: '2s' }), bridge(2)], [peerLink(1), peerLink(2)], links, none, NOW);
    expect(pair.status).toBe('warning');
  });
});

describe('the peer link in detail (#376)', () => {
  const port = (id: number, name: string, over: Partial<PortFacts> = {}): PortFacts => ({
    device_id: id, name, running: true, speed: '10Gbps', link_downs: 0, errors_24h: 0, last_down_at: null, ...over });
  const pairOf = (bonds: MlagBond[]) => buildPairs([bridge(1), bridge(2)], bonds, links, none, NOW)[0];
  const macs = new Map([[1, new Set(['04:F4:1C:EE:49:01'])], [2, new Set(['04:F4:1C:EE:4A:95'])]]);
  const vlans = new Map([[1, [40, 1, 10]], [2, [1, 10, 40]]]);

  it('lines the members up by cable, and checks each side\'s LACP partner is the other peer', () => {
    const pair = pairOf([peerLink(1, { partner_sys_id: '04:f4:1c:ee:4a:95' }), peerLink(2, { partner_sys_id: '04:F4:1C:EE:49:01', active_ports: 'sfp-sfpplus15' })]);
    const view = buildPeerLink({ pair, macs, vlans,
      ports: [port(1, 'sfp-sfpplus15'), port(1, 'sfp-sfpplus16', { errors_24h: 12, last_down_at: '2026-11-05T09:00:00Z' }), port(2, 'sfp-sfpplus15'), port(2, 'sfp-sfpplus16', { running: false })],
      // Cabled crosswise: 15 on CSW01 to 16 on CSW02.
      links: [{ from_device_id: 1, from_interface: 'sfp-sfpplus15', to_device_id: 2, to_interface: 'sfp-sfpplus16' }] });
    expect(view.members.map((m) => [m.a?.name, m.b?.name])).toEqual([['sfp-sfpplus15', 'sfp-sfpplus16'], ['sfp-sfpplus16', 'sfp-sfpplus15']]);
    expect(view.members[0].b).toMatchObject({ running: false, active: false });
    expect(view.members[1].a).toMatchObject({ errors24h: 12, speed: '10Gbps', active: true });
    expect(view.a).toEqual({ bond: 'Po15', partner: '04:F4:1C:EE:4A:95', partnerOk: true, vlans: [1, 10, 40] });
    expect(view.lastFlap).toEqual({ device: 'CSW01', member: 'sfp-sfpplus16', at: '2026-11-05T09:00:00Z', reboot: false });
    // The other peer booted a minute before: a restart, not a flap.
    const rebooted = buildPeerLink({ pair, macs, vlans, links: [], boots: new Map([[2, ['2026-11-05T08:59:00Z']]]),
      ports: [port(1, 'sfp-sfpplus16', { last_down_at: '2026-11-05T09:00:00Z' })] });
    expect(rebooted.lastFlap?.reboot).toBe(true);
    const later = buildPeerLink({ pair, macs, vlans, links: [], boots: new Map([[2, ['2026-11-04T08:00:00Z']]]),
      ports: [port(1, 'sfp-sfpplus16', { last_down_at: '2026-11-05T09:00:00Z' })] });
    expect(later.lastFlap?.reboot).toBe(false);
    expect(peerLinkFindings(pair, view)).toEqual([]);
  });

  it('calls a peer link cabled to something else critical', () => {
    const pair = pairOf([peerLink(1, { partner_sys_id: 'AA:BB:CC:00:00:01' }), peerLink(2, { partner_sys_id: '04:F4:1C:EE:49:01' })]);
    const view = buildPeerLink({ pair, macs, vlans, ports: [], links: [] });
    expect(view.a?.partnerOk).toBe(false);
    expect(peerLinkFindings(pair, view)).toEqual([expect.objectContaining({ severity: 'critical', code: 'peer-link-partner',
      text: 'CSW01: the LACP partner on the peer link Po15 is AA:BB:CC:00:00:01, not CSW02. The peer link is cabled to another device.' })]);
    // Members without discovery are paired by name.
    expect(view.members.map((m) => [m.a?.name, m.b?.name])).toEqual([['sfp-sfpplus15', 'sfp-sfpplus15'], ['sfp-sfpplus16', 'sfp-sfpplus16']]);
  });
});
