import { describe, it, expect } from 'vitest';
import { displayState } from './deviceState';

describe('displayState (#168)', () => {
  it('shows a reachable device with a hardware fault as degraded', () => {
    expect(displayState({ status: 'online', health_status: 'degraded' })).toBe('degraded');
    expect(displayState({ status: 'online', health_status: 'ok' })).toBe('online');
  });
  it('shows an intermittent device that is offline as expected, not red', () => {
    expect(displayState({ status: 'offline', intermittent: true })).toBe('expected-offline');
    expect(displayState({ status: 'offline' })).toBe('offline');
  });
  it('does not call an offline device degraded because of stale health', () => {
    expect(displayState({ status: 'offline', health_status: 'degraded' })).toBe('offline');
  });
});
