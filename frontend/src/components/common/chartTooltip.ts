import type { CSSProperties } from 'react';

/**
 * One look for chart tooltips, following the theme. Recharts' default tooltip
 * is a white box whose heading (the date) takes the page's text colour, so in
 * dark mode it was near-white on white and unreadable (Discussion #85).
 * Spread onto <Tooltip>: `<Tooltip {...chartTooltip} formatter={...} />`.
 */
export const chartTooltip: { contentStyle: CSSProperties; labelStyle: CSSProperties } = {
  contentStyle: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--ink)',
  },
  labelStyle: { color: 'var(--ink-2)', fontWeight: 600, marginBottom: 2 },
};

/**
 * For pie charts: Recharts colours each item's text with its series colour,
 * which a pie doesn't pass, so the text fell back to black, unreadable on the
 * dark tooltip (#331).
 */
export const pieTooltip: typeof chartTooltip & { itemStyle: CSSProperties } = {
  ...chartTooltip,
  itemStyle: { color: 'var(--ink)' },
};

/**
 * Keep a legend in the order its series are declared. Recharts 3 sorts legend
 * items alphabetically by default, which turned "Upload, Download" into
 * "Download, Upload". `<Legend itemSorter={inDeclaredOrder(['Upload', 'Download'])} />`
 */
export function inDeclaredOrder(names: string[]): (item: { value?: unknown }) => number {
  return (item) => {
    const i = names.indexOf(String(item.value ?? ''));
    return i === -1 ? names.length : i;
  };
}
