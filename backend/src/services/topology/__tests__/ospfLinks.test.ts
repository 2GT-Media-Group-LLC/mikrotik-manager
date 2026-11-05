import { ospfTopologyLinks, type OspfPeerRow } from '../ospfLinks';
import type { LinkRow, TopoDevice } from '../buildTopology';

const dev = (id: number, ip: string, extra: string[] = []): TopoDevice =>
  ({ id, name: `r${id}`, ip_address: ip, ip_addresses_jsonb: extra.map((a) => ({ address: `${a}/30` })) });
const peer = (over: Partial<OspfPeerRow>): OspfPeerRow =>
  ({ device_id: 1, remote_id: '10.255.0.2', remote_address: '172.16.0.2', local_interface: 'wg-b', local_interface_type: 'wg', state: 'Full', up: true, ...over });
const devices = [dev(1, '192.0.2.1', ['172.16.0.1']), dev(2, '192.0.2.2', ['172.16.0.2', '10.255.0.2'])];

describe('ospfTopologyLinks (#373)', () => {
  it('joins two managed routers once, with both ends\' interfaces', () => {
    const { links, externalNodes } = ospfTopologyLinks([
      peer({}),
      peer({ device_id: 2, remote_id: '10.255.0.1', remote_address: '172.16.0.1', local_interface: 'wg-a' }),
    ], devices, [], []);
    expect(externalNodes).toEqual([]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from_device_id: 1, to_device_id: 2, from_interface: 'wg-b', to_interface: 'wg-a', link_type: 'ospf', link_state: 'up', from_interface_type: 'wg' });
  });

  it('marks a lost adjacency down, from either end', () => {
    const { links } = ospfTopologyLinks([peer({}), peer({ device_id: 2, remote_id: '10.255.0.1', remote_address: '172.16.0.1', local_interface: 'wg-a', up: false, state: 'Down' })], devices, [], []);
    expect(links[0].link_state).toBe('down');
  });

  it('adds nothing where the map already joins the two', () => {
    const cable = { from_device_id: 2, to_device_id: 1 } as LinkRow;
    expect(ospfTopologyLinks([peer({})], devices, [cable], []).links).toEqual([]);
  });

  it('makes one node per unmanaged router, however many tunnels reach it', () => {
    const { links, externalNodes } = ospfTopologyLinks([
      peer({ remote_id: '10.9.9.9', remote_address: '172.16.5.2', local_interface: 'gre-x' }),
      peer({ device_id: 2, remote_id: '10.9.9.9', remote_address: '172.16.6.2', local_interface: 'gre-y' }),
    ], devices, [], []);
    expect(externalNodes).toEqual([expect.objectContaining({ id: 'ext-ospf10999', name: '10.9.9.9', caps: 'router', platform: 'OSPF router' })]);
    expect(links.map((l) => [l.from_device_id, l.external_id])).toEqual([[1, 'ext-ospf10999'], [2, 'ext-ospf10999']]);
  });

  it('leaves out shared segments, neighbours discovery already drew, and devices out of view', () => {
    const lan = [peer({ remote_id: '10.9.9.1', local_interface: 'vlan10' }), peer({ remote_id: '10.9.9.2', local_interface: 'vlan10' })];
    expect(ospfTopologyLinks(lan, devices, [], []).links).toEqual([]);
    const mndp = { from_device_id: 1, from_interface: 'eoip-x', neighbor_address: '172.16.7.2' } as LinkRow;
    expect(ospfTopologyLinks([peer({ remote_id: '10.9.9.9', remote_address: '172.16.7.2', local_interface: 'eoip-x' })], devices, [mndp], []).links).toEqual([]);
    expect(ospfTopologyLinks([peer({ device_id: 7 })], devices, [], []).links).toEqual([]);
  });

  it('does not take an address two devices share for either of them', () => {
    const twins = [dev(1, '192.0.2.1'), dev(2, '192.0.2.2', ['10.0.0.1']), dev(3, '192.0.2.3', ['10.0.0.1'])];
    const { links } = ospfTopologyLinks([peer({ remote_id: '10.0.0.1', remote_address: '10.0.0.1' })], twins, [], []);
    expect(links[0].to_device_id).toBeNull();
    expect(links[0].external_id).toBe('ext-ospf10001');
  });
});
