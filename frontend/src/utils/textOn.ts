const TEXT_DARK = '#111827';

function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * Text for a label drawn on a fixed colour (a green signal dot, an amber
 * histogram tile): white or near-black, whichever reads better. White on the
 * bright status colours was about 2:1 (Discussion #85).
 */
export function textOn(bg: string): string {
  return contrast(bg, '#ffffff') >= contrast(bg, TEXT_DARK) ? '#ffffff' : TEXT_DARK;
}
