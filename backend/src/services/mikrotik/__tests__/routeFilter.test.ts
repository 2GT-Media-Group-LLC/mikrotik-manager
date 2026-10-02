import { toV7FilterRule } from '../routeFilter';

describe('toV7FilterRule (C7)', () => {
  it('turns a prefix match into a rule script', () => {
    expect(toV7FilterRule({ chain: 'in', action: 'accept', prefix: '10.0.0.0/8', comment: 'c' }))
      .toEqual({ chain: 'in', comment: 'c', rule: 'if (dst in 10.0.0.0/8) { accept }' });
  });
  it('maps discard to reject and takes a bare action', () => {
    expect(toV7FilterRule({ chain: 'in', action: 'discard' })).toEqual({ chain: 'in', rule: 'reject' });
  });
  it('passes a ready-made rule through', () => {
    expect(toV7FilterRule({ chain: 'in', rule: 'if (bgp-as-path 65000) { reject }' }).rule).toBe('if (bgp-as-path 65000) { reject }');
  });
  it('refuses what it cannot express', () => {
    expect(() => toV7FilterRule({ chain: 'in', action: 'jump' })).toThrow(/jump/);
    expect(() => toV7FilterRule({ chain: 'in', prefix: '10.0.0.0/8) { accept }; if (1' })).toThrow(/prefix/);
  });
});
