import { useCallback, useRef, useState } from 'react';

/**
 * The height of `rows` rows of a list, for a list that shows that many and
 * scrolls for the rest. Measured rather than guessed so fonts and zoom can't
 * leave half a row showing: from the top of the first row to the bottom of the
 * last one shown, so rows of different heights (one with a second line, one
 * without) still show whole. With fewer rows than that, from the first row:
 * `gapPx` is the space each later row adds above itself (a divide-y line or a
 * space-y margin).
 *
 * Put the returned ref on the list element itself; its children are the rows.
 */
export function useRowsHeight(rows: number, fallbackRowPx: number, gapPx = 0) {
  const [rowPx, setRowPx] = useState(fallbackRowPx);
  const [spanPx, setSpanPx] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    // The list is watched as well as its rows: it can mount empty and get its
    // rows when the data arrives, which resizes the list but no row yet.
    const ro = new ResizeObserver(() => {
      const kids = Array.from(el.children).slice(0, rows) as HTMLElement[];
      if (kids.length === 0) return;
      for (const k of kids) ro.observe(k);
      if (kids[0].offsetHeight) setRowPx(kids[0].offsetHeight);
      setSpanPx(kids.length === rows
        ? Math.round(kids[rows - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top)
        : null);
    });
    ro.observe(el);
    observer.current = ro;
  }, [rows]);
  return [ref, spanPx ?? rowPx * rows + gapPx * (rows - 1)] as const;
}
