import { keyInReach, topologyKeyEnds, type MapReach } from '../topologyKeys';

const reach = (over: Partial<MapReach> = {}): MapReach => ({
  devices: new Set([12, 13]), nodes: new Set([3]), hands: new Set([4]),
  clients: new Set(['aa:bb:cc:dd:ee:ff']), ext: new Set(['ext-d0ea110ade77']), ...over,
});

describe('topologyKeyEnds', () => {
  it('reads every kind of map key', () => {
    expect(topologyKeyEnds('12')).toEqual([{ kind: 'device', id: 12 }]);
    expect(topologyKeyEnds('node-3')).toEqual([{ kind: 'node', id: 3 }]);
    expect(topologyKeyEnds('hand-4')).toEqual([{ kind: 'hand', id: 4 }]);
    expect(topologyKeyEnds('clients-12')).toEqual([{ kind: 'device', id: 12 }]);
    expect(topologyKeyEnds('cgedge-12')).toEqual([{ kind: 'device', id: 12 }]);
    expect(topologyKeyEnds('cvedge-clients-12:vlan:10')).toEqual([{ kind: 'device', id: 12 }]);
    expect(topologyKeyEnds('client-AA:BB:CC:DD:EE:FF')).toEqual([{ kind: 'client', mac: 'aa:bb:cc:dd:ee:ff' }]);
    expect(topologyKeyEnds('cedge-AA:BB:CC:DD:EE:FF')).toEqual([{ kind: 'client', mac: 'aa:bb:cc:dd:ee:ff' }]);
    expect(topologyKeyEnds('ext-d0ea110ade77')).toEqual([{ kind: 'ext', id: 'ext-d0ea110ade77' }]);
    expect(topologyKeyEnds('something-else')).toEqual([{ kind: 'unknown' }]);
  });

  it('reads both ends of a cable, ports and a duplicate number aside', () => {
    expect(topologyKeyEnds('cable:12@ether2|8@bridge_ether1')).toEqual([{ kind: 'device', id: 12 }, { kind: 'device', id: 8 }]);
    expect(topologyKeyEnds('cable:12@|ext-d0ea110ade77@.1')).toEqual([{ kind: 'device', id: 12 }, { kind: 'ext', id: 'ext-d0ea110ade77' }]);
  });

  it("doesn't take a lookalike for a device", () => {
    expect(topologyKeyEnds('clients-12x')).toEqual([{ kind: 'unknown' }]);
    expect(topologyKeyEnds('node-3a')).toEqual([{ kind: 'unknown' }]);
    expect(topologyKeyEnds(' 12')).toEqual([{ kind: 'unknown' }]);
  });
});

describe('keyInReach', () => {
  it('passes a key only when every end is in reach', () => {
    expect(keyInReach('cable:12@ether1|13@ether1', reach())).toBe(true);
    expect(keyInReach('cable:12@ether1|8@ether1', reach())).toBe(false);
    expect(keyInReach('8', reach())).toBe(false);
    expect(keyInReach('node-9', reach())).toBe(false);
    expect(keyInReach('hand-5', reach())).toBe(false);
    expect(keyInReach('client-11:22:33:44:55:66', reach())).toBe(false);
    expect(keyInReach('ext-2gtnwap4', reach())).toBe(false);
    expect(keyInReach('something-else', reach())).toBe(false);
  });

  it('lets any neighbour id through when the neighbours in reach are not known', () => {
    expect(keyInReach('ext-2gtnwap4', reach({ ext: null }))).toBe(true);
    expect(keyInReach('cable:8@ether1|ext-2gtnwap4@', reach({ ext: null }))).toBe(false);
  });
});
