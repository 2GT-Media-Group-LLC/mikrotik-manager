import { describe, it, expect } from 'vitest';
import { fleetActionSummary } from './fleetAction';

describe('fleetActionSummary (#392)', () => {
  it('names each device that failed, with its reason', () => {
    const s = fleetActionSummary('Backed up', {
      total: 5,
      results: [
        { id: 1, name: 'EDW-R1', ok: true },
        { id: 2, name: 'EDW-SW2', ok: false, error: 'All configured authentication methods failed' },
        { id: 3, name: 'EDW-AP1', ok: false, error: 'connect ECONNREFUSED 10.0.0.3:22' },
        { id: 4, name: 'EDW-SW1', ok: true },
        { id: 5, name: 'EDW-AP2', ok: false },
      ],
    });
    expect(s.text).toBe('Backed up 2/5 devices');
    expect(s.tone).toBe('warn');
    expect(s.failures).toEqual([
      { id: 3, name: 'EDW-AP1', error: 'connect ECONNREFUSED 10.0.0.3:22' },
      { id: 5, name: 'EDW-AP2', error: 'No reason given' },
      { id: 2, name: 'EDW-SW2', error: 'All configured authentication methods failed' },
    ]);
  });

  it('is good when all worked and bad when none did', () => {
    expect(fleetActionSummary('Synced', { total: 1, results: [{ name: 'R1', ok: true }] }))
      .toEqual({ text: 'Synced 1/1 device', tone: 'good', failures: [] });
    expect(fleetActionSummary('Synced', { total: 2, results: [{ name: 'A', ok: false, error: 'x' }, { name: 'B', ok: false, error: 'y' }] }).tone)
      .toBe('bad');
  });
});
