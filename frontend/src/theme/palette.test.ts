import css from '../index.css?raw';
import { describe, it, expect } from 'vitest';
import colors from 'tailwindcss/colors';
import { PALETTES, STEPS, accentPalette, paletteFrom, fitPalette, contrast, accentTokens, channels, normalizeHex, type AccentId } from './palette';

describe('accent palettes (#329)', () => {
  it('are Tailwind\'s own, step for step', () => {
    for (const id of Object.keys(PALETTES) as AccentId[]) {
      const tw = (colors as unknown as Record<string, Record<number, string>>)[id];
      expect(PALETTES[id]).toEqual(STEPS.map((s) => tw[s]));
    }
  });

  it('Blue writes nothing, and index.css holds Tailwind\'s blue and slate as the defaults', () => {
    expect(accentPalette('blue', '#123456')).toBeNull();
    for (const [i, step] of STEPS.entries()) {
      expect(css).toContain(`--blue-${step}: ${channels(colors.blue[step])};`);
      expect(css).toContain(`--slate-${step}: ${channels(colors.slate[step])};`);
      expect(PALETTES.blue[i]).toBe(colors.blue[step]);
    }
  });

  it('keeps white text readable on step 600, moving a light palette darker', () => {
    for (const id of Object.keys(PALETTES) as AccentId[]) {
      const p = accentPalette(id, '') ?? PALETTES.blue;
      expect(contrast(p[6], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    }
    // Amber's 600 is too light for white text: its 700 takes the place.
    expect(fitPalette(PALETTES.amber)[6]).toBe(PALETTES.amber[7]);
    // Ones that already read well are left exactly as Tailwind has them.
    expect(fitPalette(PALETTES.violet)).toEqual(PALETTES.violet);
  });

  it('builds a palette around any colour, light to dark', () => {
    for (const seed of ['#ff00ff', '#ffee00', '#00ffcc', '#202020', '#7c3aed']) {
      const p = paletteFrom(seed);
      expect(p).toHaveLength(11);
      expect(contrast(p[6], '#ffffff')).toBeGreaterThanOrEqual(4.5);
      // Lighter at 50 than at 950.
      expect(contrast(p[0], '#000000')).toBeGreaterThan(contrast(p[10], '#000000'));
    }
  });

  it('accepts only a six-digit hex from storage', () => {
    expect(normalizeHex('#AbCdEf')).toBe('#abcdef');
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#fff; background: url(x)')).toBeNull();
    expect(accentPalette('custom', 'nonsense')).toEqual(paletteFrom('#7c3aed'));
  });

  it('gives the design tokens the same values index.css has for blue', () => {
    expect(accentTokens(PALETTES.blue, false)).toEqual({ '--accent': '#2563eb', '--accent-2': '#1d4ed8', '--accent-soft': '#eff6ff', '--accent-fg': '#ffffff' });
    expect(accentTokens(PALETTES.blue, true)).toEqual({ '--accent': '#60a5fa', '--accent-2': '#3b82f6', '--accent-soft': 'rgba(96, 165, 250, 0.1)', '--accent-fg': '#0e0f12' });
  });
});
