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
