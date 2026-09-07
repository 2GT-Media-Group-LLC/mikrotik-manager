import { describe, it, expect } from 'vitest';
import { fleetStatus } from './fleetStatus';

describe('fleetStatus', () => {
  // The reported bug: switching site remounts with no summary, and the header
  // interpolated it straight into the string.
  it('reports loading rather than "undefined devices unreachable"', () => {
    for (const absent of [undefined, null]) {
      const s = fleetStatus(absent);
      expect(s.kind).toBe('loading');
      expect(s.headline).not.toMatch(/undefined|NaN/);
      expect(s.sentence).not.toMatch(/undefined|NaN/);
    }
  });

  // Defaulting the missing summary to 0 would have swapped one wrong claim for
  // another: an unheard-from fleet is not a healthy one.
  it('does not claim health while loading', () => {
    expect(fleetStatus(undefined).tone).toBe('neutral');
    expect(fleetStatus(undefined).kind).not.toBe('healthy');
  });

  it('distinguishes an empty site from a healthy one', () => {
    const empty = fleetStatus({ total: 0, online: 0, offline: 0 });
    expect(empty.kind).toBe('empty');
    expect(empty.sentence).toBe('No devices in this site yet.');

    const healthy = fleetStatus({ total: 3, online: 3, offline: 0 });
    expect(healthy.kind).toBe('healthy');
    expect(healthy.tone).toBe('good');
  });

  it('counts and pluralises unreachable devices', () => {
    expect(fleetStatus({ total: 4, online: 3, offline: 1 }).headline)
      .toBe('1 device unreachable');
    expect(fleetStatus({ total: 4, online: 2, offline: 2 }).sentence)
      .toBe('2 devices unreachable.');
    expect(fleetStatus({ total: 4, online: 2, offline: 2 }).tone).toBe('warn');
  });

  it('never emits undefined or NaN for any input', () => {
    const cases = [
      undefined, null,
      { total: 0, online: 0, offline: 0 },
      { total: 1, online: 0, offline: 1 },
      { total: 9, online: 9, offline: 0 },
    ];
    for (const c of cases) {
      const s = fleetStatus(c);
      expect(`${s.headline} ${s.sentence}`).not.toMatch(/undefined|NaN|null/);
    }
  });
});
