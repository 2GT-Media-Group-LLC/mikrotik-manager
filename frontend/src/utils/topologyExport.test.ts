import { describe, it, expect } from 'vitest';
import { exportFrame, exportFileName, svgWithBackground, EXPORT_PADDING } from './topologyExport';

describe('exportFrame', () => {
  it('frames every card with padding and moves the top-left card to it', () => {
    const f = exportFrame({ x: -120, y: 50, width: 1000, height: 600 });
    expect(f).toEqual({
      width: 1000 + 2 * EXPORT_PADDING, height: 600 + 2 * EXPORT_PADDING, pixelRatio: 2,
      transform: `translate(${EXPORT_PADDING + 120}px, ${EXPORT_PADDING - 50}px) scale(1)`,
    });
  });

  it('draws a map too big for double size at less', () => {
    const f = exportFrame({ x: 0, y: 0, width: 9920, height: 2000 }, 8000);
    expect(f.width).toBe(10000);
    expect(f.pixelRatio).toBeCloseTo(0.8);
  });
});

describe('exportFileName', () => {
  const day = new Date(2026, 10, 3, 9, 30);
  it('names the view and the day', () => {
    expect(exportFileName('HQ', day)).toBe('topology-HQ-2026-11-03.png');
    expect(exportFileName('All sites', day)).toBe('topology-All-sites-2026-11-03.png');
    expect(exportFileName('HQ', day, 'svg')).toBe('topology-HQ-2026-11-03.svg');
  });
  it('keeps the name safe for any file system', () => {
    expect(exportFileName('Branch / Floor 2: "East"', day)).toBe('topology-Branch-Floor-2-East-2026-11-03.png');
    expect(exportFileName('   ', day)).toBe('topology-map-2026-11-03.png');
  });
});

describe('svgWithBackground', () => {
  const url = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  it('fills the whole image behind the map', () => {
    const out = svgWithBackground(url('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><foreignObject/></svg>'), 'rgb(15, 23, 42)');
    expect(decodeURIComponent(out.split(',').slice(1).join(','))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="100%" height="100%" fill="rgb(15, 23, 42)"/><foreignObject/></svg>');
    expect(out.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  });
  it('leaves anything else alone and keeps the colour inside its attribute', () => {
    expect(svgWithBackground('not a data url', '#fff')).toBe('not a data url');
    const out = decodeURIComponent(svgWithBackground(url('<svg>x</svg>'), '"/><script>').split(',')[1]);
    expect(out).toBe('<svg><rect width="100%" height="100%" fill="/script"/>x</svg>');
  });
});
