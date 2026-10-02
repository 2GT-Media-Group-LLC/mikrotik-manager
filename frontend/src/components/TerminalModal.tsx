import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io, Socket } from 'socket.io-client';
import { X, Maximize2, Minimize2, TerminalSquare, AlertCircle, RefreshCw } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import '@xterm/xterm/css/xterm.css';

const MIN_W = 480;
const MIN_H = 300;
const DEFAULT_W = 900;
const DEFAULT_H = 560;

interface Props {
  deviceId: number;
  deviceName: string;
  onClose: () => void;
}

type ConnState = 'connecting' | 'ready' | 'error' | 'closed';

const RESIZE_HANDLES = [
  { dir: 'n',  cursor: 'ns-resize',   style: { top: 0,    left: 6,    right: 6,   height: 6              } },
  { dir: 'ne', cursor: 'nesw-resize', style: { top: 0,    right: 0,               width: 10, height: 10  } },
  { dir: 'e',  cursor: 'ew-resize',   style: { top: 6,    right: 0,   bottom: 6,  width: 6               } },
  { dir: 'se', cursor: 'nwse-resize', style: { bottom: 0, right: 0,               width: 10, height: 10  } },
  { dir: 's',  cursor: 'ns-resize',   style: { bottom: 0, left: 6,    right: 6,   height: 6              } },
  { dir: 'sw', cursor: 'nesw-resize', style: { bottom: 0, left: 0,                width: 10, height: 10  } },
  { dir: 'w',  cursor: 'ew-resize',   style: { top: 6,    left: 0,    bottom: 6,  width: 6               } },
  { dir: 'nw', cursor: 'nwse-resize', style: { top: 0,    left: 0,                width: 10, height: 10  } },
] as const;

export default function TerminalModal({ deviceId, deviceName, onClose }: Props) {
  const termRef   = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const xtermRef  = useRef<Terminal | null>(null);
  const fitRef    = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const [connState, setConnState] = useState<ConnState>('connecting');
  const [errorMsg,  setErrorMsg]  = useState('');
  const [maximized, setMaximized] = useState(false);

  const [pos,  setPos]  = useState(() => ({
    x: Math.max(0, (window.innerWidth  - DEFAULT_W) / 2),
    y: Math.max(0, (window.innerHeight - DEFAULT_H) / 2),
  }));
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const savedGeometry = useRef({ pos: { x: 0, y: 0 }, size: { w: DEFAULT_W, h: DEFAULT_H } });

  const token = useAuthStore((s) => s.token);

  // ─── SSH connection ────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    socketRef.current?.disconnect();
    xtermRef.current?.clear();
    setConnState('connecting');
    setErrorMsg('');

    const socket = io('/terminal', {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      const fit = fitRef.current;
      fit?.fit();
      socket.emit('start', {
        deviceId,
        cols: xtermRef.current?.cols ?? 80,
        rows: xtermRef.current?.rows ?? 24,
      });
    });
    socket.on('ready',        ()           => { setConnState('ready'); xtermRef.current?.focus(); });
    socket.on('data',         (d: string)  => { xtermRef.current?.write(d); });
    socket.on('close',        ()           => { setConnState('closed'); xtermRef.current?.write('\r\n\x1b[33m[Session closed]\x1b[0m\r\n'); });
    socket.on('error',        (msg: string)=> { setConnState('error'); setErrorMsg(msg); });
    socket.on('connect_error',(err)        => { setConnState('error'); setErrorMsg(err.message); });
    // Functional update: the handler is created once, so reading connState here
    // saw its value at connect time and a dropped session stayed "Connected" (U8).
    socket.on('disconnect',   ()           => {
      setConnState((s) => {
        if (s === 'ready') xtermRef.current?.write('\r\n\x1b[33m[Connection lost]\x1b[0m\r\n');
        return s === 'ready' ? 'closed' : s;
      });
    });
  }, [deviceId, token]);

  // ─── Terminal init (once) ─────────────────────────────────────────────────
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: '#0f172a', foreground: '#e2e8f0', cursor: '#3b82f6',
        black: '#1e293b',    red: '#ef4444',   green: '#22c55e',   yellow: '#eab308',
        blue: '#3b82f6',     magenta: '#a855f7', cyan: '#06b6d4',  white: '#f1f5f9',
        brightBlack: '#475569', brightRed: '#f87171', brightGreen: '#4ade80',
        brightYellow: '#fbbf24', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
        brightCyan: '#22d3ee', brightWhite: '#ffffff',
      },
      allowProposedApi: false,
      // Links a device prints (OSC 8) can show any label over any target (U12).
      // Only web links open, and only after showing the real address.
      linkHandler: {
        activate: (_e, uri) => {
          let url: URL;
          try { url = new URL(uri); } catch { return; }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
          if (window.confirm(`The device output links to:\n\n${url.href}\n\nOpen it in a new tab?`)) {
            window.open(url.href, '_blank', 'noopener,noreferrer');
          }
        },
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current   = fit;

    const disposable = term.onData((data) => {
      if (socketRef.current?.connected) socketRef.current.emit('data', data);
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (socketRef.current?.connected) {
        socketRef.current.emit('resize', { cols: term.cols, rows: term.rows });
      }
    });
    if (termRef.current) ro.observe(termRef.current);

    connect();

    return () => {
      disposable.dispose();
      ro.disconnect();
      term.dispose();
      socketRef.current?.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit after maximize toggle
  useEffect(() => {
    setTimeout(() => {
      fitRef.current?.fit();
      if (socketRef.current?.connected && xtermRef.current) {
        socketRef.current.emit('resize', { cols: xtermRef.current.cols, rows: xtermRef.current.rows });
      }
    }, 50);
  }, [maximized]);

  // ─── Maximize / restore ───────────────────────────────────────────────────
  const toggleMaximize = () => {
    if (!maximized) {
      savedGeometry.current = { pos: { ...pos }, size: { ...size } };
      setMaximized(true);
    } else {
      setMaximized(false);
      setPos(savedGeometry.current.pos);
      setSize(savedGeometry.current.size);
    }
  };

  // ─── Drag (title bar) ─────────────────────────────────────────────────────
  const handleTitleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (maximized || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const el = windowRef.current;
    if (!el) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const origX  = el.offsetLeft;
    const origY  = el.offsetTop;

    document.body.style.cursor     = 'grabbing';
    document.body.style.userSelect = 'none';

    const onMove = (me: MouseEvent) => {
      el.style.left = `${Math.max(0, origX + me.clientX - startX)}px`;
      el.style.top  = `${Math.max(0, origY + me.clientY - startY)}px`;
    };
    const onUp = () => {
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      setPos({ x: el.offsetLeft, y: el.offsetTop });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    e.preventDefault();
  };

  // ─── Resize (edge / corner handles) ───────────────────────────────────────
  const handleResizeMouseDown = (e: React.MouseEvent, dir: string) => {
    if (maximized || e.button !== 0) return;
    const el = windowRef.current;
    if (!el) return;

    const startX  = e.clientX;
    const startY  = e.clientY;
    const origL   = el.offsetLeft;
    const origT   = el.offsetTop;
    const origW   = el.offsetWidth;
    const origH   = el.offsetHeight;

    // eslint-disable-next-line react-hooks/immutability
    document.body.style.userSelect = 'none';

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      let l = origL, t = origT, w = origW, h = origH;

      if (dir.includes('e')) w = Math.max(MIN_W, origW + dx);
      if (dir.includes('s')) h = Math.max(MIN_H, origH + dy);
      if (dir.includes('w')) { w = Math.max(MIN_W, origW - dx); l = origL + origW - w; }
      if (dir.includes('n')) { h = Math.max(MIN_H, origH - dy); t = origT + origH - h; }

      el.style.left   = `${l}px`;
      el.style.top    = `${t}px`;
      el.style.width  = `${w}px`;
      el.style.height = `${h}px`;
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      setPos ({ x: el.offsetLeft,  y: el.offsetTop    });
      setSize({ w: el.offsetWidth, h: el.offsetHeight });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    e.preventDefault();
    e.stopPropagation();
  };

  const handleReconnect = () => { xtermRef.current?.clear(); connect(); };

  // ─── Render ───────────────────────────────────────────────────────────────
  return createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Window */}
      <div
        ref={windowRef}
        className="flex flex-col bg-slate-900 shadow-2xl border border-slate-700 overflow-hidden"
        style={maximized
          ? { position: 'fixed', inset: 0, zIndex: 10000, borderRadius: 0 }
          : { position: 'fixed', left: pos.x, top: pos.y, width: size.w, height: size.h,
              zIndex: 10000, borderRadius: '0.75rem', minWidth: MIN_W, minHeight: MIN_H }
        }
      >
        {/* Resize handles */}
        {!maximized && RESIZE_HANDLES.map(({ dir, cursor, style }) => (
          <div
            key={dir}
            style={{ position: 'absolute', zIndex: 10, cursor, ...style }}
            onMouseDown={(e) => handleResizeMouseDown(e, dir)}
          />
        ))}

        {/* Title bar — drag target */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 border-b border-slate-700 select-none shrink-0"
          style={{ cursor: maximized ? 'default' : 'grab' }}
          onMouseDown={handleTitleMouseDown}
          onDoubleClick={toggleMaximize}
        >
          <TerminalSquare className="w-4 h-4 text-green-400 shrink-0" />
          <span className="text-sm font-medium text-slate-200 flex-1 truncate">
            SSH — {deviceName}
          </span>

          {connState === 'connecting' && (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400">
              <RefreshCw className="w-3 h-3 animate-spin" /> Connecting…
            </span>
          )}
          {connState === 'ready' && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> Connected
            </span>
          )}
          {(connState === 'error' || connState === 'closed') && (
            <button
              onClick={handleReconnect}
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 px-2 py-0.5 rounded border border-blue-700 hover:border-blue-500 transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> Reconnect
            </button>
          )}

          <button
            onClick={toggleMaximize}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error banner */}
        {connState === 'error' && errorMsg && (
          <div className="flex items-start gap-2 px-4 py-2.5 bg-red-900/40 border-b border-red-800 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Terminal */}
        <div className="flex-1 min-h-0 p-1 bg-[#0f172a]">
          <div ref={termRef} className="w-full h-full" />
        </div>
      </div>
    </>,
    document.body
  );
}
