import { describe, it, expect } from 'vitest';
import { redirectLocked, loginNeededAgain } from './jumpHostEdit';

const saved = { host: '203.0.113.10', port: 22 };

describe('redirectLocked', () => {
  it('locks the address, port and host key for anyone but a fleet admin while devices use it', () => {
    expect(redirectLocked({ device_count: 3 }, false)).toBe(true);
    expect(redirectLocked({ device_count: 3 }, true)).toBe(false);
  });

  it('leaves them open on a jump host no device uses', () => {
    expect(redirectLocked({ device_count: 0 }, false)).toBe(false);
  });
});

describe('loginNeededAgain', () => {
  it('asks for the login again when the address or port changes', () => {
    expect(loginNeededAgain(saved, { host: '198.51.100.7', port: '22' }, false)).toBe(true);
    expect(loginNeededAgain(saved, { host: '203.0.113.10', port: '2222' }, false)).toBe(true);
  });

  it("doesn't for the saved address, a blank port (kept), or a fleet admin", () => {
    expect(loginNeededAgain(saved, { host: ' 203.0.113.10 ', port: '22' }, false)).toBe(false);
    expect(loginNeededAgain(saved, { host: '203.0.113.10', port: '' }, false)).toBe(false);
    expect(loginNeededAgain(saved, { host: '198.51.100.7', port: '2222' }, true)).toBe(false);
  });
});
