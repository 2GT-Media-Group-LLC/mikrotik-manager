import { counterDeltas } from '../counterDeltas';

// Outside review J4: a client seen by two access points has two counters.
describe('counterDeltas', () => {
  it('takes deltas per device, then adds them up', () => {
    const out = counterDeltas([
      { time: 't1', device: '1', value: 1_000_000 },
      { time: 't2', device: '1', value: 1_000_500 },
      { time: 't1', device: '2', value: 40 },
      { time: 't2', device: '2', value: 100 },
    ]);
    // Merged, the series would have stepped between the two counters.
    expect(out.get('t2')).toBe(560);
    expect(out.has('t1')).toBe(false);
  });

  it('skips a counter reset', () => {
    const out = counterDeltas([
      { time: 't1', device: '1', value: 500 },
      { time: 't2', device: '1', value: 20 },
      { time: 't3', device: '1', value: 70 },
    ]);
    expect(out.has('t2')).toBe(false);
    expect(out.get('t3')).toBe(50);
  });
});
