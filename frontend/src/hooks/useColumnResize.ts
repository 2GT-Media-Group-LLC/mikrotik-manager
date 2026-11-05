import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import { clampWidth, type ColumnPrefs } from '../utils/columnPrefs';

/**
 * Drag a header's right edge to resize its column, double-click to reset it
 * (#283, #336). Pass the handle's mouse-down event; the header is its parent.
 */
export function useColumnResize<Id extends string>(setPrefs: Dispatch<SetStateAction<ColumnPrefs<Id>>>) {
  const startResize = (e: ReactMouseEvent<HTMLElement>, id: Id) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.parentElement;
    if (!th) return;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const w = clampWidth(startW + ev.clientX - startX);
      setPrefs((p) => (p.widths[id] === w ? p : { ...p, widths: { ...p.widths, [id]: w } }));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  const resetWidth = (id: Id) =>
    setPrefs((p) => { const widths = { ...p.widths }; delete widths[id]; return { ...p, widths }; });
  return { startResize, resetWidth };
}
