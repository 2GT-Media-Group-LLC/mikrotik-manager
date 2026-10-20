import { useState } from 'react';

/** A chart range: "1h", "24h", "7d" and the like. */
const RANGE = /^\d{1,3}[mhdw]$/;

/**
 * A chart's time range that this browser remembers (#331): pick 7d once and
 * it stays 7d next time, instead of going back to the default. One key per
 * chart, so each keeps its own. A stored value that isn't a range (or isn't
 * one this chart offers) is ignored.
 */
export function useRememberedRange<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const storageKey = `range:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored && RANGE.test(stored) && (!allowed || allowed.includes(stored as T))) return stored as T;
    } catch { /* private mode */ }
    return fallback;
  });
  const set = (v: T) => {
    setValue(v);
    try { localStorage.setItem(storageKey, v); } catch { /* private mode */ }
  };
  return [value, set];
}
