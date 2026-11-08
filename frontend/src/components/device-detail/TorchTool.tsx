import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Play, Square, Loader2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';

/** One flow in a Torch frame, as the server sends it (#416). */
export interface TorchFlow {
  mac: string;
  proto: string;
  src: string;
  srcPort: string;
  dst: string;
  dstPort: string;
  tx: number;
  rx: number;
  txPackets: number;
  rxPackets: number;
}

const PROTOCOLS = ['any', 'tcp', 'udp', 'icmp', 'icmpv6', 'gre', 'esp', 'ospf'];

/** Bits per second, compact. */
export function formatBitRate(bps: number): string {
  if (!bps) return '0';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(bps >= 1e5 ? 0 : 1)} kbps`;
  return `${bps} bps`;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type State = 'idle' | 'connecting' | 'live' | 'stopped' | 'error';

/**
 * Live Torch (#416): who is talking on an interface right now, refreshed each
 * second by the router. It stops by itself after the server's time limit, and
 * when this panel closes.
 */
export default function TorchTool({ deviceId, interfaces }: { deviceId: number; interfaces: string[] }) {
  const token = useAuthStore((s) => s.token);
  const [iface, setIface] = useState('');
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [port, setPort] = useState('');
  const [protocol, setProtocol] = useState('any');
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');
  const [flows, setFlows] = useState<TorchFlow[]>([]);
  const [total, setTotal] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [maxMs, setMaxMs] = useState(0);
  const [now, setNow] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  const chosen = iface || interfaces[0] || '';

  useEffect(() => () => { socketRef.current?.disconnect(); }, []);
  useEffect(() => {
    if (state !== 'live') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  const start = () => {
    socketRef.current?.disconnect();
    setFlows([]); setTotal(0); setMessage(''); setState('connecting');
    const socket = io('/torch', { path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      socket.emit('start', { deviceId, interface: chosen, srcAddress: src, dstAddress: dst, port, protocol });
    });
    socket.on('started', (s: { maxMs: number }) => { setMaxMs(s.maxMs); setStartedAt(Date.now()); setNow(Date.now()); setState('live'); });
    socket.on('frame', (f: { flows: TorchFlow[]; total: number }) => { setFlows(f.flows); setTotal(f.total); });
    socket.on('stopped', (s: { reason: string }) => {
      setState((st) => (st === 'error' ? st : 'stopped'));
      if (s.reason === 'time limit') setMessage('Stopped at the time limit. Start again to keep watching.');
      socket.disconnect();
    });
    socket.on('error', (msg: string) => { setState('error'); setMessage(msg); });
    socket.on('connect_error', (err) => { setState('error'); setMessage(err.message); socket.disconnect(); });
  };

  const stop = () => {
    if (state === 'connecting') {
      // Not started on the router yet: closing the socket is enough.
      socketRef.current?.disconnect();
      setState('stopped');
      return;
    }
    socketRef.current?.emit('stop');
  };

  const running = state === 'connecting' || state === 'live';
  const sumTx = flows.reduce((a, f) => a + f.tx, 0);
  const sumRx = flows.reduce((a, f) => a + f.rx, 0);
  const input = 'input text-sm';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500 dark:text-slate-400">
          Interface
          <select className={`${input} block mt-1`} value={chosen} disabled={running} onChange={(e) => setIface(e.target.value)}>
            {interfaces.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-500 dark:text-slate-400">
          Source
          <input className={`${input} block mt-1 w-40`} placeholder="any" value={src} disabled={running} onChange={(e) => setSrc(e.target.value)} />
        </label>
        <label className="text-xs text-gray-500 dark:text-slate-400">
          Destination
          <input className={`${input} block mt-1 w-40`} placeholder="any" value={dst} disabled={running} onChange={(e) => setDst(e.target.value)} />
        </label>
        <label className="text-xs text-gray-500 dark:text-slate-400">
          Port
          <input className={`${input} block mt-1 w-20`} placeholder="any" inputMode="numeric" value={port} disabled={running} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label className="text-xs text-gray-500 dark:text-slate-400">
          Protocol
          <select className={`${input} block mt-1`} value={protocol} disabled={running} onChange={(e) => setProtocol(e.target.value)}>
            {PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        {running ? (
          <button onClick={stop} className="btn-secondary flex items-center gap-2 shrink-0">
            {state === 'connecting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
            Stop
          </button>
        ) : (
          <button onClick={start} disabled={!chosen} className="btn-primary flex items-center gap-2 shrink-0">
            <Play className="w-4 h-4" /> Start
          </button>
        )}
      </div>

      <p className="text-xs text-gray-500 dark:text-slate-400">
        {state === 'live'
          ? <>Live on <span className="font-mono">{chosen}</span> · {mmss(now - startedAt)} of {mmss(maxMs)} · {total} flow{total === 1 ? '' : 's'}{total > flows.length ? `, busiest ${flows.length} shown` : ''} · TX {formatBitRate(sumTx)} / RX {formatBitRate(sumRx)}</>
          : 'Torch shows the traffic on an interface right now, refreshed every second. It uses the router\'s CPU while it runs, so it stops by itself after 10 minutes. Traffic that a switch chip forwards in hardware doesn\'t pass the CPU and isn\'t shown.'}
      </p>
      {message && (
        <p role="status" className={state === 'error' ? 'text-sm text-red-600 dark:text-red-400' : 'text-sm text-gray-600 dark:text-slate-300'}>{message}</p>
      )}

      {(state === 'live' || (state === 'stopped' && flows.length > 0)) && (
        <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-white dark:bg-slate-800">
              <tr className="border-b border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400">
                {['Proto', 'Source', 'Port', 'Destination', 'Port', 'TX', 'RX', 'TX pkt/s', 'RX pkt/s'].map((h, i) => (
                  <th key={i} className={`px-3 py-1.5 font-medium ${i >= 5 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50 table-zebra">
              {flows.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-3 text-gray-400 dark:text-slate-500">No traffic matching this right now.</td></tr>
              ) : flows.map((f, i) => (
                <tr key={`${f.proto}|${f.src}|${f.srcPort}|${f.dst}|${f.dstPort}|${i}`} className="text-gray-700 dark:text-slate-300">
                  <td className="px-3 py-1">{f.proto || f.mac}</td>
                  <td className="px-3 py-1">{f.src}</td>
                  <td className="px-3 py-1">{f.srcPort}</td>
                  <td className="px-3 py-1">{f.dst}</td>
                  <td className="px-3 py-1">{f.dstPort}</td>
                  <td className="px-3 py-1 text-right">{formatBitRate(f.tx)}</td>
                  <td className="px-3 py-1 text-right">{formatBitRate(f.rx)}</td>
                  <td className="px-3 py-1 text-right">{f.txPackets}</td>
                  <td className="px-3 py-1 text-right">{f.rxPackets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
