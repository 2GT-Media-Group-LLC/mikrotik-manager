import { describe, it, expect } from 'vitest';
import { orderForDiff, type ComparableBackup } from './backupCompare';

const backups: ComparableBackup[] = [
  { id: 10, created_at: '2026-09-01T10:00:00Z' },
  { id: 20, created_at: '2026-09-05T10:00:00Z' },
  { id: 30, created_at: '2026-09-08T10:00:00Z' },
];

describe('orderForDiff', () => {
  // The property that matters: whichever order the user clicked in, the diff
  // reads forwards in time. Selecting newest-then-oldest must not invert it.
  it('always returns [older, newer]', () => {
    expect(orderForDiff([10, 30], backups)).toEqual([10, 30]);
    expect(orderForDiff([30, 10], backups)).toEqual([10, 30]);
    expect(orderForDiff([30, 20], backups)).toEqual([20, 30]);
  });

  it('refuses anything other than a pair', () => {
    expect(orderForDiff([], backups)).toBeNull();
    expect(orderForDiff([10], backups)).toBeNull();
    expect(orderForDiff([10, 20, 30], backups)).toBeNull();
  });

  // Two backups taken in the same second is unlikely but possible; the result
  // must still be stable rather than depending on click order.
  it('is stable when timestamps tie', () => {
    const tied: ComparableBackup[] = [
      { id: 7, created_at: '2026-09-01T10:00:00Z' },
      { id: 9, created_at: '2026-09-01T10:00:00Z' },
    ];
    expect(orderForDiff([9, 7], tied)).toEqual([7, 9]);
    expect(orderForDiff([7, 9], tied)).toEqual([7, 9]);
  });

  it('falls back to id when a backup is missing or undated', () => {
    expect(orderForDiff([99, 98], [])).toEqual([98, 99]);
    const bad: ComparableBackup[] = [
      { id: 1, created_at: 'not-a-date' },
      { id: 2, created_at: 'not-a-date' },
    ];
    expect(orderForDiff([2, 1], bad)).toEqual([1, 2]);
  });
});
