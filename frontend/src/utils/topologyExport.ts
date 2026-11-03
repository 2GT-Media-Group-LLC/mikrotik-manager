/**
 * Export the topology map as a PNG or SVG (#367). Draws the whole map, not
 * only what's on screen, as it's shown now: the site or device view, clients,
 * curved or straight links, the theme. The SVG is the page's HTML inside an
 * SVG: it scales in a browser, but Visio, Inkscape and the like don't draw it.
 */

export type ExportFormat = 'png' | 'svg';

export interface Bounds { x: number; y: number; width: number; height: number }

/** Space around the cards, in map pixels. */
export const EXPORT_PADDING = 40;
/** Browsers draw nothing past about 16k pixels a side; stay well inside that. */
export const MAX_EXPORT_PX = 8000;

/**
 * The image to draw: the cards' bounds plus padding, at map scale, moved so
 * the top-left card sits at the padding. PNGs are drawn at twice the size for
 * sharp text, less for a map too big for that.
 */
export function exportFrame(b: Bounds, maxPx = MAX_EXPORT_PX): { width: number; height: number; pixelRatio: number; transform: string } {
  const width = Math.ceil(b.width + 2 * EXPORT_PADDING);
  const height = Math.ceil(b.height + 2 * EXPORT_PADDING);
  const pixelRatio = Math.min(2, maxPx / Math.max(width, height, 1));
  return {
    width, height, pixelRatio,
    transform: `translate(${EXPORT_PADDING - b.x}px, ${EXPORT_PADDING - b.y}px) scale(1)`,
  };
}

/** topology-HQ-2026-11-03.png: what it shows and when, safe on any file system. */
export function exportFileName(scope: string, when: Date, format: ExportFormat = 'png'): string {
  const safe = scope.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return `topology-${safe}-${day}.${format}`;
}

/** The first background colour that isn't transparent, from `el` up. */
export function backgroundOf(el: HTMLElement | null): string {
  for (let e = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
  }
  return '#ffffff';
}

/**
 * The SVG with its background filled edge to edge. The library colours the
 * map's own element, which the frame moves into place, so a bare SVG had
 * strips of no colour along two sides; a PNG fills its canvas first.
 */
export function svgWithBackground(dataUrl: string, color: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl;
  const svg = decodeURIComponent(dataUrl.slice(comma + 1));
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  if (open < 0) return dataUrl;
  const fill = color.replace(/["<>&]/g, '');
  const filled = `${svg.slice(0, open + 1)}<rect width="100%" height="100%" fill="${fill}"/>${svg.slice(open + 1)}`;
  return `${dataUrl.slice(0, comma + 1)}${encodeURIComponent(filled)}`;
}

/**
 * Draw the map in `viewport` (React Flow's .react-flow__viewport) and download
 * it. Elements marked data-export="skip" (remove buttons) are left out. The
 * image library loads on first use only.
 */
export async function downloadTopology(viewport: HTMLElement, bounds: Bounds, format: ExportFormat, fileName: string): Promise<void> {
  const { toBlob, toSvg } = await import('html-to-image');
  const frame = exportFrame(bounds);
  const options = {
    backgroundColor: backgroundOf(viewport.parentElement),
    width: frame.width,
    height: frame.height,
    pixelRatio: frame.pixelRatio,
    style: { width: `${frame.width}px`, height: `${frame.height}px`, transform: frame.transform },
    filter: (node: HTMLElement) => !(node instanceof HTMLElement && node.dataset.export === 'skip'),
  };
  const a = document.createElement('a');
  a.download = fileName;
  if (format === 'svg') {
    // A data: URL; the page's CSP doesn't let it be fetched into a blob.
    a.href = svgWithBackground(await toSvg(viewport, options), options.backgroundColor);
    a.click();
    return;
  }
  const blob = await toBlob(viewport, options);
  if (!blob) throw new Error('the browser could not draw it');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
