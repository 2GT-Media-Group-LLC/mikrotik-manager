import { describe, it, expect } from 'vitest';
import { isIpOrPrefix, splitList } from './ipPrefix';

describe('isIpOrPrefix / splitList (#207)', () => {
  it('accepts addresses and prefixes', () => {
    for (const ok of ['10.0.0.1', '10.0.0.0/8', '0.0.0.0/0', '2001:db8::1', '2001:db8::/32', '::/0']) expect(isIpOrPrefix(ok)).toBe(true);
  });
  it('rejects the rest', () => {
    for (const bad of ['10.0.0.0/33', '2001:db8::/129', 'host.example', '10.0.0.0/8/1', '', '10.0.0']) expect(isIpOrPrefix(bad)).toBe(false);
  });
  it('splits on commas, spaces and new lines', () => {
    expect(splitList(' 10.0.0.0/8, 192.168.1.0/24\n2001:db8::/32;10.1.1.1 ')).toEqual(['10.0.0.0/8', '192.168.1.0/24', '2001:db8::/32', '10.1.1.1']);
  });
});
