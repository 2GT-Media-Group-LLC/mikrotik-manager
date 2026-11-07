/**
 * Accent colours (theming, after kraken-XIV's proposal in #329).
 *
 * The UI's accent is Tailwind's `blue` palette: `bg-blue-600` buttons,
 * `text-blue-600` links, `border-blue-500` focus and so on, about 900 uses.
 * tailwind.config.js points every `blue-N` at a CSS variable (`--blue-N`,
 * "r g b" channels), whose defaults in index.css are Tailwind's own blue. An
 * accent replaces those eleven variables, so the whole UI follows it without
 * touching a component, and with Blue chosen nothing is written at all: the
 * page renders exactly as before.
 *
 * Primary buttons put white text on step 600 and links use 600 on white, so
 * a palette whose 600 is too light for that (amber, emerald, teal) is moved
 * a step darker from 500 down. A custom colour gets a palette built around
 * it the same way.
 */

export const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

export type AccentId = 'blue' | 'indigo' | 'violet' | 'emerald' | 'teal' | 'amber' | 'rose';

/** Tailwind 3's palettes, 50 → 950. */
export const PALETTES: Record<AccentId, string[]> = {
  blue: ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a', '#172554'],
  indigo: ['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b'],
  violet: ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'],
  emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'],
  teal: ['#f0fdfa', '#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59', '#134e4a', '#042f2e'],
  amber: ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f', '#451a03'],
  rose: ['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337', '#4c0519'],
};

export const ACCENTS: { id: AccentId; label: string }[] = [
  { id: 'blue', label: 'Blue' }, { id: 'indigo', label: 'Indigo' }, { id: 'violet', label: 'Violet' },
  { id: 'emerald', label: 'Emerald' }, { id: 'teal', label: 'Teal' }, { id: 'amber', label: 'Amber' }, { id: 'rose', label: 'Rose' },
];

export const DEFAULT_CUSTOM = '#7c3aed';

type Rgb = [number, number, number];

/** Only an opaque six-digit hex colour crosses the storage → CSS boundary. */
export function normalizeHex(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}

export function toRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex(c: Rgb): string {
  return `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return a.map((x, i) => x + (b[i] - x) * t) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const BLACK: Rgb = [0, 0, 0];

/**
 * A palette whose step 600 carries white text (4.5:1) and reads as a link on
 * white. Steps from 500 down move darker together until it does; the light
 * steps are left alone.
 */
export function fitPalette(p: string[]): string[] {
  let shift = 0;
  const at = (i: number): string => {
    if (i < 5) return p[i];
    const j = i + shift;
    return j <= 10 ? p[j] : toHex(mix(toRgb(p[10]), BLACK, Math.min(0.8, 0.25 * (j - 10))));
  };
  while (contrast(at(6), '#ffffff') < 4.5 && shift < 6) shift++;
  return STEPS.map((_, i) => at(i));
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B); const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// Tailwind blue's lightness, step by step: the curve a built palette follows.
const LIGHTNESS = [0.97, 0.93, 0.87, 0.78, 0.68, 0.6, 0.53, 0.48, 0.4, 0.33, 0.21];

/** A palette for any colour: its hue and saturation along blue's lightness curve. */
export function paletteFrom(hex: string): string[] {
  const [h, s] = toHsl(toRgb(normalizeHex(hex) ?? DEFAULT_CUSTOM));
  // A grey stays grey; a faint tint is given enough colour to read as an accent.
  const sat = s < 0.05 ? 0 : Math.max(s, 0.45);
  return fitPalette(LIGHTNESS.map((l) => toHex(fromHsl(h, sat, l))));
}

export type AccentChoice = AccentId | 'custom';

/** The eleven `--blue-N` values for a choice, or null for Blue (write nothing). */
export function accentPalette(choice: AccentChoice, custom: string): string[] | null {
  if (choice === 'blue') return null;
  if (choice === 'custom') return paletteFrom(custom);
  return fitPalette(PALETTES[choice] ?? PALETTES.blue);
}

/** "r g b" for a CSS variable used as `rgb(var(--x) / <alpha-value>)`. */
export function channels(hex: string): string {
  return toRgb(hex).join(' ');
}

/** The design-token accent variables (index.css) from a palette, per mode. */
export function accentTokens(p: string[], dark: boolean): Record<string, string> {
  const [r, g, b] = toRgb(p[4]);
  return dark
    ? { '--accent': p[4], '--accent-2': p[5], '--accent-soft': `rgba(${r}, ${g}, ${b}, 0.1)`, '--accent-fg': '#0e0f12' }
    : { '--accent': p[6], '--accent-2': p[7], '--accent-soft': p[0], '--accent-fg': '#ffffff' };
}
