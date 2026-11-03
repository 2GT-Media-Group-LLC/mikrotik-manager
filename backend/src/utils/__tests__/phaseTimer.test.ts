import { phaseTimer } from '../phaseTimer';

describe('phaseTimer (#368)', () => {
  it('times each phase from the end of the one before', () => {
    const times = [0, 12.34, 20, 1020];
    const t = phaseTimer(() => times.shift()!);
    t.mark('db');
    t.mark('metrics');
    t.mark('the checks');
    expect(t.header()).toBe('db;dur=12.3, metrics;dur=7.7, the_checks;dur=1000.0');
  });
});
