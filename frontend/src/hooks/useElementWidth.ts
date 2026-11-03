import { useCallback, useEffect, useState } from 'react';

/**
 * The width of an element, kept current as it resizes. For a card that lays
 * itself out by its own width rather than the window's (#368). 0 until
 * measured. A callback ref, so an element that mounts later is measured too.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: T | null) => setEl(node), []);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, width] as const;
}
