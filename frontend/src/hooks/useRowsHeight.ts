import { useCallback, useRef, useState } from 'react';

/**
 * The height of `rows` rows of a list, measured from its first row, for a list
 * that shows that many and scrolls for the rest. Measured rather than guessed
 * so fonts and zoom can't leave half a row showing. `gapPx` is the space each
 * later row adds above itself (a divide-y line or a space-y margin).
 *
 * Put the returned ref on the list element itself; its children are the rows.
 */
export function useRowsHeight(rows: number, fallbackRowPx: number, gapPx = 0) {
  const [rowPx, setRowPx] = useState(fallbackRowPx);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    // The list is watched as well as its first row: it can mount empty and get
    // its rows when the data arrives, which resizes the list but no row yet.
    const ro = new ResizeObserver(() => {
      const first = el.firstElementChild as HTMLElement | null;
      if (!first) return;
      ro.observe(first);
      if (first.offsetHeight) setRowPx(first.offsetHeight);
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, rowPx * rows + gapPx * (rows - 1)] as const;
}
