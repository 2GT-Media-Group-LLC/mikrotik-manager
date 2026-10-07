import { readCounters, counterDelta, isEmpty, summarise, describeErrors, type ErrorEvent } from '../interfaceErrors';

// Field names and shapes as a CRS518 and a wAP ax (RouterOS 7.24.5) report them.
const crs = (fcs: string, align = '0', extra: Record<string, string> = {}) =>
  ({ name: 'qsfp28-1-1', 'rx-fcs-error': fcs, 'rx-align-error': align, 'rx-overflow': '0', 'rx-fragment': '0', 'rx-jabber': '0', 'rx-too-long': '9', ...extra });

describe('readCounters / counterDelta', () => {
  it('groups counters by kind and ignores oversized frames', () => {
    const c = readCounters(crs('40', '2', { 'rx-jabber': '1', 'tx-late-collision': '3' }), '5');
    expect(c).toEqual({ errors: { fcs: 40, align: 2, overflow: 0, other: 4 }, linkDowns: 5 });
  });

  it('copes with a model that lacks some counters', () => {
    const c = readCounters({ name: 'ether1', 'rx-fcs-error': '7' }, undefined);
    expect(c).toEqual({ errors: { fcs: 7, align: 0, overflow: 0, other: 0 }, linkDowns: null });
  });

  it('returns how much each counter grew', () => {
    const d = counterDelta(readCounters(crs('100'), '2'), readCounters(crs('130', '1'), '3'));
    expect(d).toEqual({ errors: { fcs: 30, align: 1, overflow: 0, other: 0 }, linkDowns: 1 });
    expect(isEmpty(d!)).toBe(false);
  });

  it('treats a counter going backwards as a reset, not as errors', () => {
    expect(counterDelta(readCounters(crs('500'), '4'), readCounters(crs('3'), '0'))).toBeNull();
    expect(counterDelta(readCounters(crs('5'), '4'), readCounters(crs('5'), '1'))).toBeNull();
  });

  it('sees a quiet interval as empty', () => {
    expect(isEmpty(counterDelta(readCounters(crs('5'), '1'), readCounters(crs('5'), '1'))!)).toBe(true);
  });
});

describe('summarise', () => {
  const ev = (iface: string, ago: number, fcs: number, link_downs = 0): ErrorEvent =>
    ({ interface: iface, ago_sec: ago, fcs, align: 0, overflow: 0, other: 0, link_downs });

  it('is red when the 5-minute rate reaches the threshold', () => {
    // 60 errors in the last 5 minutes = 12/min.
    const [p] = summarise([ev('sfp28-1', 30, 20), ev('sfp28-1', 90, 20), ev('sfp28-1', 250, 20)], 10, 3);
    expect(p).toMatchObject({ interface: 'sfp28-1', rate_per_min: 12, state: 'alert', flapping: false, last_error_ago_sec: 30 });
    expect(p.hour.fcs).toBe(60);
  });

  it('is yellow for errors still arriving below the threshold', () => {
    const [p] = summarise([ev('sfp28-1', 600, 8)], 10, 3);
    expect(p).toMatchObject({ rate_per_min: 0, state: 'errors' });
  });

  it('is quiet when the errors stopped more than 15 minutes ago, but keeps the hour totals', () => {
    const [p] = summarise([ev('sfp28-1', 1800, 500)], 10, 3);
    expect(p.state).toBeNull();
    expect(p.hour.fcs).toBe(500);
  });

  it('flags flapping on link drops alone', () => {
    const [p] = summarise([ev('ether3', 100, 0, 1), ev('ether3', 900, 0, 1), ev('ether3', 2000, 0, 1)], 10, 3);
    expect(p).toMatchObject({ flapping: true, state: 'alert', rate_per_min: 0 });
    expect(summarise([ev('ether3', 100, 0, 2)], 10, 3)[0]).toMatchObject({ flapping: false, state: null });
  });

  it('ignores anything older than an hour and sorts ports naturally', () => {
    const out = summarise([ev('sfp28-10', 10, 1), ev('sfp28-2', 10, 1), ev('sfp28-1', 4000, 99)]);
    expect(out.map((p) => p.interface)).toEqual(['sfp28-2', 'sfp28-10']);
  });

  it('adds counts that arrive as strings (pg returns BIGINT as text)', () => {
    const e = { interface: 'sfp28-1', ago_sec: 30, fcs: '76', align: '4', overflow: '0', other: '0', link_downs: 0 } as unknown as ErrorEvent;
    const [p] = summarise([e], 10, 3);
    expect(p.hour).toMatchObject({ fcs: 76, align: 4 });
    expect(p.rate_per_min).toBe(16);
  });

  it('describes only the kinds that grew', () => {
    expect(describeErrors({ fcs: 40, align: 2, overflow: 0, other: 0 })).toBe('FCS 40, alignment 2');
  });
});
