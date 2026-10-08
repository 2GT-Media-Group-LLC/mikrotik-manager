import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Maximize2, Minimize2 } from 'lucide-react';

/**
 * A window over the page, like the SSH terminal's: drag it by the title bar,
 * resize it from any edge or corner, double-click the title to maximize, close
 * with ✕, Esc or a click outside. For details too long to sit in a card
 * without stretching the cards beside it.
 */

const HANDLES = [
  { dir: 'n',  cursor: 'ns-resize',   style: { top: 0, left: 6, right: 6, height: 6 } },
  { dir: 'ne', cursor: 'nesw-resize', style: { top: 0, right: 0, width: 10, height: 10 } },
  { dir: 'e',  cursor: 'ew-resize',   style: { top: 6, right: 0, bottom: 6, width: 6 } },
  { dir: 'se', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: 10, height: 10 } },
  { dir: 's',  cursor: 'ns-resize',   style: { bottom: 0, left: 6, right: 6, height: 6 } },
  { dir: 'sw', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: 10, height: 10 } },
  { dir: 'w',  cursor: 'ew-resize',   style: { top: 6, left: 0, bottom: 6, width: 6 } },
  { dir: 'nw', cursor: 'nwse-resize', style: { top: 0, left: 0, width: 10, height: 10 } },
] as const;

export default function FloatingWindow({
  title, icon, onClose, children, width = 560, height = 620, minWidth = 360, minHeight = 260,
}: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [geom, setGeom] = useState(() => {
    const w = Math.min(width, window.innerWidth - 32);
    const h = Math.min(height, window.innerHeight - 32);
    return { x: Math.max(16, (window.innerWidth - w) / 2), y: Math.max(16, (window.innerHeight - h) / 2), w, h };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Follow the mouse until it's released, then keep the result. */
  const track = (e: React.MouseEvent, move: (dx: number, dy: number) => void) => {
    const el = ref.current;
    if (!el || maximized || e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    // A drag in progress mustn't select text across the page (as the terminal does).
    // eslint-disable-next-line react-hooks/immutability
    document.body.style.userSelect = 'none';
    const onMove = (me: MouseEvent) => move(me.clientX - sx, me.clientY - sy);
    const onUp = () => {
      document.body.style.userSelect = '';
      setGeom({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  const onDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = ref.current!;
    const ox = el.offsetLeft;
    const oy = el.offsetTop;
    track(e, (dx, dy) => {
      el.style.left = `${Math.max(0, ox + dx)}px`;
      el.style.top = `${Math.max(0, oy + dy)}px`;
    });
  };

  const onResize = (e: React.MouseEvent, dir: string) => {
    e.stopPropagation();
    const el = ref.current!;
    const o = { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    track(e, (dx, dy) => {
      let { l, t, w, h } = o;
      if (dir.includes('e')) w = Math.max(minWidth, o.w + dx);
      if (dir.includes('s')) h = Math.max(minHeight, o.h + dy);
      if (dir.includes('w')) { w = Math.max(minWidth, o.w - dx); l = o.l + o.w - w; }
      if (dir.includes('n')) { h = Math.max(minHeight, o.h - dy); t = o.t + o.h - h; }
      Object.assign(el.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
    });
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className="flex flex-col shadow-2xl overflow-hidden"
        style={{
          background: 'var(--surface)', border: '1px solid var(--line)', zIndex: 10000,
          ...(maximized
            ? { position: 'fixed', inset: 0, borderRadius: 0 }
            : { position: 'fixed', left: geom.x, top: geom.y, width: geom.w, height: geom.h, borderRadius: '0.75rem', minWidth, minHeight }),
        }}
      >
        {!maximized && HANDLES.map(({ dir, cursor, style }) => (
          <div key={dir} style={{ position: 'absolute', zIndex: 10, cursor, ...style }} onMouseDown={(e) => onResize(e, dir)} />
        ))}
        <div
          className="flex items-center gap-2 px-4 py-2.5 select-none shrink-0"
          style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--line)', cursor: maximized ? 'default' : 'grab' }}
          onMouseDown={onDrag}
          onDoubleClick={() => setMaximized((m) => !m)}
        >
          {icon}
          <span className="text-sm font-medium flex-1 truncate" style={{ color: 'var(--ink)' }}>{title}</span>
          <button onClick={() => setMaximized((m) => !m)} title={maximized ? 'Restore' : 'Maximize'}
            className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10" style={{ color: 'var(--ink-3)' }}>
            {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={onClose} title="Close" className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10" style={{ color: 'var(--ink-3)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">{children}</div>
      </div>
    </>,
    document.body,
  );
}
