import { useId } from 'react';
import { classifyPort, portBasis, type PortLike } from '../../utils/portClass';

/**
 * Faceplate ports drawn as the hardware looks (#412, after Ron's mockup):
 * an RJ45 jack, an SFP cage, a QSFP28 or QSFP-DD cage, one lane of a cage
 * that's broken out, or a virtual port with no jack at all. All 32 high; the
 * width follows the kind. Colours come from the theme, so up ports take the
 * accent colour.
 */
export type GlyphKind = 'rj45' | 'sfp' | 'qsfp' | 'qsfpdd' | 'lane' | 'virtual';
export type GlyphState = 'up' | 'down' | 'disabled';

export const GLYPH_WIDTH: Record<GlyphKind, number> = { rj45: 40, sfp: 40, virtual: 40, qsfp: 58, qsfpdd: 58, lane: 28 };
const HEIGHT = 32;
/** Drawn in a 32-high box and shown 1.3× that, so an RJ45 is 52 wide: bigger than the old 46px tiles. */
export const GLYPH_SCALE = 1.3;
const LINK = '#4ade80';

const gbps = (rate?: string | null): number => {
  const m = /([\d.]+)\s*([GM])/i.exec(rate ?? '');
  if (!m) return 0;
  return Number(m[1]) / (m[2].toUpperCase() === 'M' ? 1000 : 1);
};

/**
 * Which drawing a port gets. `wholeCage` is set when a QSFP cage shows as one
 * port: either a cage that isn't broken out, or one fast link using all its
 * lanes, which the faceplate draws as that lane.
 */
export function glyphKind(port: PortLike & { link_rate?: string | null; speed?: string | null }, wholeCage = false): GlyphKind {
  const id = classifyPort(port);
  if (id.kind === 'virtual') return 'virtual';
  if (id.kind === 'copper') return 'rj45';
  if (id.kind === 'sfp') return 'sfp';
  if (id.kind === 'qsfp-lane' && !wholeCage) return 'lane';
  // QSFP-DD (and QSFP56-DD) by name, or by a link no QSFP28 can carry.
  const dd = /dd/i.test(portBasis(port)) || gbps(port.link_rate ?? port.speed) >= 200;
  return dd ? 'qsfpdd' : 'qsfp';
}

export default function PortGlyph({ kind, state, tone, watts }: {
  kind: GlyphKind;
  state: GlyphState;
  /** Errors or low optic light: the frame and the "!" take this colour. */
  tone?: string | null;
  /** PoE draw; shown as a badge when above zero. */
  watts?: number;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const metal = `pm${uid}`, glow = `pg${uid}`;
  const W = GLYPH_WIDTH[kind], mid = W / 2;
  const up = state === 'up', off = state === 'disabled';
  const frame = tone ?? (up ? 'var(--accent)' : 'var(--port-frame-off)');
  const lo = up ? 'var(--port-metal-lo)' : 'var(--port-metal-off-lo)';
  const gold = up ? '#d4a94a' : '#7d6a45';

  const led = (cx: number, color: string) => (up ? (
    <g key={cx}>
      <circle cx={cx} cy={7.6} r={3.2} fill={color} opacity={0.35} filter={`url(#${glow})`} />
      <circle cx={cx} cy={7.6} r={1.7} fill={color} />
    </g>
  ) : <circle key={cx} cx={cx} cy={7.6} r={1.5} fill="var(--port-jack)" opacity={0.55} />);
  const shield = <rect x={4} y={4} width={W - 8} height={24} rx={2.2} fill={`url(#${metal})`} />;
  const sheen = (x: number, y: number, w: number) => <rect x={x} y={y} width={w} height={1} fill="#fff" opacity={0.07} />;
  const pads = (y: number, count: number, x0: number, x1: number) => Array.from({ length: count }, (_, i) => (
    <rect key={`${y}-${i}`} x={x0 + (i * (x1 - x0)) / (count - 1) - 0.5} y={y} width={1} height={2} rx={0.3} fill={gold} />
  ));

  let body: React.ReactNode;
  if (kind === 'rj45') {
    // The jack: its opening with the latch notch on top, and eight contacts.
    body = <>
      {shield}
      <path d="M9 11.5 H15.5 V9.6 H24.5 V11.5 H31 V26 H9 Z" fill="var(--port-jack)" />
      {sheen(10.2, 12.6, 19.6)}
      {Array.from({ length: 8 }, (_, i) => <rect key={i} x={11.6 + i * 2.25} y={22.2} width={1} height={3.2} rx={0.3} fill={gold} />)}
      {led(7.4, LINK)}{led(32.6, 'var(--accent)')}
    </>;
  } else if (kind === 'sfp' || kind === 'lane') {
    // A cage: the slot, the pull tab under it, one link light. A lane is the narrow one.
    const inset = kind === 'lane' ? 6 : 7.5;
    const tab = kind === 'lane' ? 6 : 8;
    body = <>
      {shield}
      <rect x={inset} y={11} width={W - 2 * inset} height={12.5} rx={1} fill="var(--port-jack)" />
      {sheen(inset + 1.5, 12.4, W - 2 * inset - 3)}
      <rect x={mid - tab / 2} y={24.6} width={tab} height={1.8} rx={0.6} fill={lo} />
      {led(mid, LINK)}
    </>;
  } else if (kind === 'qsfp' || kind === 'qsfpdd') {
    // The wider cage. QSFP28 shows one row of contacts in the slot, QSFP-DD a second.
    const dd = kind === 'qsfpdd';
    body = <>
      {shield}
      <rect x={7} y={10.5} width={W - 14} height={13.5} rx={1.2} fill="var(--port-jack)" />
      {sheen(8.5, 11.8, W - 17)}
      {pads(dd ? 15.2 : 17.5, 12, 11, W - 11)}
      {dd && pads(19.6, 12, 11, W - 11)}
      <rect x={mid - 7} y={25} width={14} height={1.8} rx={0.6} fill={lo} />
      {led(8, LINK)}{led(W - 8, 'var(--accent)')}
    </>;
  } else {
    // Virtual: no jack, three linked nodes.
    const c = up ? 'var(--accent)' : 'var(--ink-4)';
    body = <>
      <rect x={4} y={4} width={32} height={24} rx={2.2} fill="var(--surface-3)" />
      <path d="M13 21 L20 14 L27 21" stroke={c} strokeWidth={1.4} fill="none" />
      {[[13, 21], [20, 14], [27, 21]].map(([x, y]) => <circle key={x} cx={x} cy={y} r={2.4} fill={c} />)}
      {led(20, LINK)}
    </>;
  }

  return (
    <svg width={W * GLYPH_SCALE} height={HEIGHT * GLYPH_SCALE} viewBox={`0 0 ${W} ${HEIGHT}`} aria-hidden="true"
      style={{ overflow: 'visible', opacity: off ? 0.5 : 1, display: 'block' }}>
      <defs>
        <linearGradient id={metal} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={up ? 'var(--port-metal-hi)' : 'var(--port-metal-off-hi)'} />
          <stop offset="1" stopColor={lo} />
        </linearGradient>
        <filter id={glow} x="-2" y="-2" width="5" height="5"><feGaussianBlur stdDeviation="1.2" /></filter>
      </defs>
      {up && !tone && (
        <rect x={1} y={1} width={W - 2} height={30} rx={4.5} fill="none" stroke="var(--accent)" strokeWidth={3} opacity={0.22} filter={`url(#${glow})`} />
      )}
      <rect x={1} y={1} width={W - 2} height={30} rx={4.5} fill="var(--surface-2)" stroke={frame} strokeWidth={tone ? 2 : 1.5}
        strokeDasharray={off || kind === 'virtual' ? '3 2' : undefined} />
      {body}
      {tone && <>
        <circle cx={3} cy={3} r={5} fill={tone} stroke="var(--surface)" strokeWidth={1.2} />
        <text x={3} y={6.1} textAnchor="middle" fontSize={8.5} fontWeight={800} fill="var(--surface)" fontFamily="system-ui">!</text>
      </>}
      {watts && watts > 0 ? <>
        <rect x={W - 16} y={25} width={16} height={7} rx={2} fill="#f59e0b" />
        <text x={W - 8} y={30.3} textAnchor="middle" fontSize={5.6} fontWeight={800} fill="#1a1205" fontFamily="system-ui">{watts.toFixed(0)}W</text>
      </> : null}
    </svg>
  );
}
