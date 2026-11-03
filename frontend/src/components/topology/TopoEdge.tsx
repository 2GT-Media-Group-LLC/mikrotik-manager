import { createContext, useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, getSmoothStepPath, getBezierPath, Position, type EdgeProps, type InternalNode } from '@xyflow/react';
import { X } from 'lucide-react';
import { linkEnds, curveEnds, sideOf, type CurveEnds, type Rect, type Side } from '../../utils/topologyGeometry';

/**
 * Where each curved link meets its cards, worked out by the page for the whole
 * map so links leaving one side are spread along it (#367). An edge not in it
 * works its ends out alone.
 */
export const CurveEndsContext = createContext<Map<string, CurveEnds> | null>(null);

/** What a link on the map carries; see toFlowEdge in the page. */
export interface TopoEdgeData extends Record<string, unknown> {
  label?: string;
  /** Drawn by hand: shown with a pill and a remove button. */
  hand?: boolean;
  onDelete?: () => void;
  /** Sides an end is pinned to, when someone chose one. */
  sourceSide?: Side | null;
  targetSide?: Side | null;
  /** Second and later cables between the same two cards are shifted aside. */
  parallel?: number;
  /** Draw it as a curve rather than a straight line (#367). */
  curved?: boolean;
  /** Sightings of the same pair on VLANs, VRRP or tunnels folded into this line (#367). */
  folded?: string[];
}

const POSITION: Record<Side, Position> = { t: Position.Top, b: Position.Bottom, l: Position.Left, r: Position.Right };

const rectOf = (n: InternalNode): Rect => ({
  x: n.internals.positionAbsolute.x,
  y: n.internals.positionAbsolute.y,
  w: n.measured?.width ?? n.width ?? 150,
  h: n.measured?.height ?? n.height ?? 60,
});

/**
 * Every link on the topology map (#147): a curve from the bottom of the upper
 * card to the top of the lower one (#367), or a straight line from card edge
 * to card edge, that follows the cards as they move; or from a side chosen by
 * hand.
 */
export default function TopoEdge({ id, source, target, data, style, markerEnd }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  const spread = useContext(CurveEndsContext)?.get(id);
  if (!s || !t) return null;
  const d = (data ?? {}) as TopoEdgeData;
  const rs = rectOf(s);
  const rt = rectOf(t);
  let path: string;
  let mid: { x: number; y: number };
  if (d.curved && !d.sourceSide && !d.targetSide) {
    const c = spread ?? curveEnds(rs, rt, d.parallel ?? 0);
    const [p, lx, ly] = getBezierPath({
      sourceX: c.s.x, sourceY: c.s.y, sourcePosition: POSITION[c.sSide],
      targetX: c.t.x, targetY: c.t.y, targetPosition: POSITION[c.tSide],
      curvature: 0.35,
    });
    path = p;
    mid = { x: lx, y: ly };
  } else if (d.sourceSide || d.targetSide) {
    const ends = linkEnds(rs, rt, d.sourceSide, d.targetSide, d.parallel ?? 0);
    // A side chosen by hand: leave and enter it at a right angle and route
    // around, as a wiring diagram does. A straight line from a side would just
    // run back across the card.
    const [p, lx, ly] = getSmoothStepPath({
      sourceX: ends.s.x, sourceY: ends.s.y, sourcePosition: POSITION[d.sourceSide ?? sideOf(rs, ends.s)],
      targetX: ends.t.x, targetY: ends.t.y, targetPosition: POSITION[d.targetSide ?? sideOf(rt, ends.t)],
      borderRadius: 8, offset: 24,
    });
    path = p;
    mid = { x: lx, y: ly };
  } else {
    const ends = linkEnds(rs, rt, null, null, d.parallel ?? 0);
    path = `M ${ends.s.x},${ends.s.y} L ${ends.t.x},${ends.t.y}`;
    mid = { x: (ends.s.x + ends.t.x) / 2, y: (ends.s.y + ends.t.y) / 2 };
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={18} />
      {(d.label || d.hand || !!d.folded?.length) && (
        <EdgeLabelRenderer>
          {/* Labels ignore the pointer unless told otherwise; nodrag/nopan stop a
              click on the button panning the map. */}
          <div className="absolute flex items-center gap-1 nodrag nopan"
            style={{ transform: `translate(-50%,-50%) translate(${mid.x}px,${mid.y}px)`, pointerEvents: 'all', opacity: style?.opacity }}>
            {d.hand ? (
              <>
                <span className="text-[9px] bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 px-1 rounded">{d.label || 'drawn by hand'}</span>
                {d.onDelete && (
                  <button data-export="skip" className="w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600"
                    onClick={(ev) => { ev.stopPropagation(); d.onDelete?.(); }} title="Remove this hand-drawn link">
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </>
            ) : (
              <>
                {d.label && <span className="text-[10px] px-1 rounded bg-slate-50/90 dark:bg-slate-800/90 text-slate-500 dark:text-slate-400 whitespace-nowrap">{d.label}</span>}
                {!!d.folded?.length && (
                  <span className="text-[9px] font-semibold px-1 rounded bg-slate-200/90 dark:bg-slate-700/90 text-slate-600 dark:text-slate-300 whitespace-nowrap cursor-help"
                    title={`Also heard between these two on:\n${d.folded.join('\n')}`}>+{d.folded.length}</span>
                )}
              </>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
