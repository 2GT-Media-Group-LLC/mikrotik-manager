import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Maximize, Pause, Play, Radio, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { devicesApi, wirelessApi } from '../../services/api';
import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';
import { useSiteStore } from '../../store/siteStore';
import { chartTooltip } from '../common/chartTooltip';
import type { Device } from '../../types';
import type { AlignmentPeer, AlignmentSnapshot } from '../../types/antennaAlignment';
import {
  alignmentPeerKey, alignmentSampleFresh, appendAlignmentPoint, canAlignAntenna,
  initialAlignmentSelection, weakestAlignmentSignal,
  type AlignmentHistory, type AlignmentSelection,
} from '../../utils/antennaAlignment';

const emptySelection: AlignmentSelection = { radio: '', peer: '' };
const value = (n: number | null | undefined, unit: string) => n == null ? '—' : `${Number(n.toFixed(1))} ${unit}`;

function useVisible() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  return visible;
}

function useRadioReading(deviceId: number | undefined, active: boolean, interval: number, now: number) {
  const siteId = useSiteStore(s => s.currentSiteId);
  const [selection, setSelection] = useState(emptySelection);
  const [seen, setSeen] = useState<AlignmentSnapshot | undefined>();
  const [held, setHeld] = useState<{ identity: string; peer: AlignmentPeer; receivedAt: number } | null>(null);
  const query = useQuery({
    queryKey: ['antenna-alignment', siteId, deviceId],
    queryFn: ({ signal }) => wirelessApi.alignment(deviceId!, signal).then(r => r.data),
    enabled: active && deviceId !== undefined,
    refetchInterval: active ? interval : false,
    refetchIntervalInBackground: false,
    retry: false,
    gcTime: 0,
  });
  // Adjust the local selection when new external query data arrives. Keep the
  // chosen peer after a dropout rather than reselecting on every render.
  if (query.data && query.data !== seen) {
    setSeen(query.data);
    setSelection(current => {
      const next = initialAlignmentSelection(query.data, current);
      return next.radio === current.radio && next.peer === current.peer ? current : next;
    });
  }
  const radio = query.data?.radios.find(r => r.key === selection.radio);
  const peer = radio?.peers.find(p => alignmentPeerKey(p) === selection.peer);
  const identity = `${deviceId}:${selection.radio}:${selection.peer}`;
  if (!query.isError && peer?.connected && peer.signal_dbm !== null
    && (held?.identity !== identity || held.receivedAt !== query.dataUpdatedAt)) {
    setHeld({ identity, peer, receivedAt: query.dataUpdatedAt });
  }
  const clock = Math.max(now, query.dataUpdatedAt);
  const linked = active && !query.isError && !!peer?.connected && alignmentSampleFresh(query.dataUpdatedAt, clock);
  const fresh = linked && peer?.signal_dbm != null;
  const last = held?.identity === identity && alignmentSampleFresh(held.receivedAt, clock) ? held : null;
  const shownPeer = fresh ? peer : last?.peer ?? (linked ? peer : undefined);
  const error = (query.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error
    ?? (query.isError ? 'Could not read the radio. Retrying at the selected refresh interval.' : radio?.error);
  return { query, selection, setSelection, radio, peer: shownPeer, linked, fresh, error };
}

type Reading = ReturnType<typeof useRadioReading>;

function RadioCard({ device, reading, side, active }: { device: Device; reading: Reading; side: string; active: boolean }) {
  const { formatTime } = useDateTimeFormat();
  const { radio, peer, selection, setSelection, linked, fresh, error, query } = reading;
  const chains = peer?.chain_signals.filter((n): n is number => n !== null) ?? [];
  const delta = chains.length >= 2 ? Math.max(...chains) - Math.min(...chains) : null;
  const status = !active ? 'Paused' : fresh ? 'Live' : peer?.signal_dbm != null ? 'Last reading' : linked ? 'Signal unavailable' : query.isFetching ? 'Reading…'
    : error ? 'Unavailable' : !selection.radio ? 'Select interface' : !selection.peer && radio?.peers.length ? 'Select peer' : 'No link';
  return (
    <div className="card p-5 space-y-4 min-w-0">
      <div className="flex justify-between items-start gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500 dark:text-slate-400">{side}</div>
          <h3 className="font-semibold text-gray-900 dark:text-white truncate">{device.name}</h3>
          <p className="text-xs font-mono text-gray-500 dark:text-slate-400">{device.ip_address}</p>
        </div>
        <span className="text-xs rounded-full px-2 py-1 shrink-0" style={{
          color: fresh ? 'var(--accent)' : 'var(--warn)', background: fresh ? 'var(--accent-bg)' : 'var(--warn-bg)',
        }}>{status}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-gray-600 dark:text-slate-300">Interface
          <select className="input mt-1" aria-label={`${side} interface`} value={selection.radio}
            onChange={e => setSelection({ radio: e.target.value, peer: '' })}>
            <option value="">Select interface</option>
            {selection.radio && !radio && <option value={selection.radio}>{selection.radio} (unavailable)</option>}
            {query.data?.radios.map(r => <option key={r.key} value={r.key}>{r.name} ({r.package}){r.disabled ? ' — disabled' : ''}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600 dark:text-slate-300">Peer
          <select className="input mt-1" aria-label={`${side} peer`} value={selection.peer}
            onChange={e => setSelection(current => ({ ...current, peer: e.target.value }))}>
            <option value="">Select peer</option>
            {selection.peer && !radio?.peers.some(p => alignmentPeerKey(p) === selection.peer)
              && <option value={selection.peer}>{selection.peer} (disconnected)</option>}
            {radio?.peers.map(p => <option key={alignmentPeerKey(p)} value={alignmentPeerKey(p)}>{p.mac_address ?? 'Associated peer'}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{error}</p>}
      {linked && !fresh && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">The peer is registered, but the radio returned no current RX signal measurement.</p>}
      {query.data && query.data.radios.length === 0 && <p className="text-sm text-gray-500">No supported wireless interfaces found on this device.</p>}
      {radio?.disabled && <p className="text-sm text-amber-700 dark:text-amber-300">This interface is disabled.</p>}
      <div className="flex items-baseline gap-2" style={{ opacity: fresh ? 1 : 0.55 }}>
        <span className="text-5xl sm:text-6xl font-mono font-semibold tabular-nums text-gray-900 dark:text-white">
          {peer?.signal_dbm == null ? '—' : peer.signal_dbm}
        </span>
        <span className="text-gray-500 dark:text-slate-400">dBm</span>
      </div>
      <div className="h-3 rounded-full overflow-hidden bg-gray-100 dark:bg-slate-700" aria-hidden="true">
        <div className="h-full transition-[width] duration-300" style={{ background: fresh ? 'var(--accent)' : 'var(--warn)',
          width: `${peer?.signal_dbm == null ? 0 : Math.max(0, Math.min(100, (peer.signal_dbm + 100) / 0.6))}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {[
          ['SNR', value(peer?.snr_db, 'dB')], ['Chain spread', value(delta, 'dB')],
          ['TX CCQ', value(peer?.tx_ccq, '%')], ['RX CCQ', value(peer?.rx_ccq, '%')],
          ['TX link rate', value(peer?.tx_rate_mbps, 'Mbps')], ['RX link rate', value(peer?.rx_rate_mbps, 'Mbps')],
          ['Peer RX signal', value(peer?.remote_signal_dbm, 'dBm')],
          ...(radio?.package === 'w60g' ? [['Signal quality', value(peer?.signal_quality, '%')], ['Distance', value(peer?.distance_m, 'm')]] : []),
        ].map(([label, display]) => <div key={label}>
          <dt className="text-xs text-gray-500 dark:text-slate-400">{label}</dt>
          <dd className="font-mono text-gray-900 dark:text-white">{display}</dd>
        </div>)}
        {peer?.chain_signals.map((n, i) => <div key={i}>
          <dt className="text-xs text-gray-500 dark:text-slate-400">Chain {i}</dt>
          <dd className="font-mono text-gray-900 dark:text-white">{value(n, 'dBm')}</dd>
        </div>)}
      </dl>
      {peer?.sector_info && <p className="text-sm text-gray-600 dark:text-slate-300">Beam direction: {peer.sector_info}</p>}
      <div className="text-xs text-gray-500 dark:text-slate-400 break-words space-y-1">
        {radio && <p>{radio.ssid ?? 'SSID unavailable'} · {radio.mode ?? 'Mode unavailable'}{radio.mac_address && ` · ${radio.mac_address}`}</p>}
        {query.data && <p>Sample: {formatTime(query.data.sampled_at, { second: '2-digit' })} · {peer?.source ?? 'waiting for a link'}</p>}
        {query.data?.warnings.map(w => <p key={w}>{w}</p>)}
      </div>
    </div>
  );
}

function SignalHistory({ a, b, paired, sampleKey, active, time }: {
  a: number | null; b: number | null; paired: boolean; sampleKey: string; active: boolean; time: number;
}) {
  const { formatTime } = useDateTimeFormat();
  const weakest = weakestAlignmentSignal(paired ? [a, b] : [a]);
  const [record, setRecord] = useState<{ history: AlignmentHistory; sample: string }>({
    history: { points: [], best: null }, sample: '',
  });
  const { history } = record;
  const [audioOn, setAudioOn] = useState(false);
  const [audioError, setAudioError] = useState('');
  const sound = useRef<{ context: AudioContext; oscillator: OscillatorNode; gain: GainNode } | null>(null);
  const key = `${sampleKey}:${weakest === null ? 'gap' : 'valid'}`;
  if (active && sampleKey && key !== record.sample) {
    setRecord({ sample: key, history: appendAlignmentPoint(history, { time, a, b, weakest }) });
  }
  useEffect(() => {
    const s = sound.current;
    if (!s) return;
    s.gain.gain.setTargetAtTime(audioOn && active && weakest !== null ? 0.035 : 0, s.context.currentTime, 0.05);
    if (weakest !== null) s.oscillator.frequency.setTargetAtTime(220 + Math.max(0, Math.min(1, (weakest + 100) / 60)) * 1100, s.context.currentTime, 0.06);
  }, [audioOn, active, weakest]);
  useEffect(() => () => {
    const s = sound.current;
    if (s) { s.oscillator.stop(); void s.context.close(); }
  }, []);
  const toggleAudio = async () => {
    if (audioOn) { setAudioOn(false); return; }
    try {
      if (!sound.current) {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        sound.current = { context, oscillator, gain };
      }
      await sound.current.context.resume();
      setAudioError('');
      setAudioOn(true);
    } catch { setAudioError('Audio is unavailable in this browser.'); }
  };
  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">{paired ? 'Weakest end of the link' : 'Local RX signal'}</h3>
          <p className="text-xs text-gray-500 dark:text-slate-400">Higher (less negative) dBm means a stronger received signal.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary flex items-center gap-2" type="button" onClick={toggleAudio} aria-pressed={audioOn}>
            {audioOn ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}{audioOn ? 'Mute tone' : 'Enable tone'}
          </button>
          <button className="btn-secondary flex items-center gap-2" type="button"
            onClick={() => setRecord({ history: { points: [], best: null }, sample: '' })}>
            <RotateCcw className="w-4 h-4" />Reset best
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[['Current', value(weakest, 'dBm')], ['Best this session', value(history.best, 'dBm')],
          ['Below best', value(weakest !== null && history.best !== null ? Math.max(0, history.best - weakest) : null, 'dB')]]
          .map(([label, display]) => <div key={label} className="min-w-0"><div className="text-xs text-gray-500 dark:text-slate-400">{label}</div>
            <div className="text-lg sm:text-2xl font-mono text-gray-900 dark:text-white">{display}</div></div>)}
      </div>
      {audioError && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{audioError}</p>}
      <div className="h-56" aria-label="Live signal history">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history.points} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
            <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={t => formatTime(t, { second: '2-digit' })} tick={{ fontSize: 10 }} />
            <YAxis domain={[-100, -30]} unit=" dBm" tick={{ fontSize: 10 }} width={65} />
            <Tooltip {...chartTooltip} labelFormatter={t => formatTime(Number(t), { second: '2-digit' })} formatter={n => value(Number(n), 'dBm')} />
            <Line dataKey="a" name="End A" stroke="var(--info)" dot={false} isAnimationActive={false} />
            {paired && <Line dataKey="b" name="End B" stroke="var(--violet)" dot={false} isAnimationActive={false} />}
            <Line dataKey="weakest" name={paired ? 'Weakest end' : 'Local RX'} stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-gray-500 dark:text-slate-400">History and best values belong to this browser session. Missing or old readings leave a gap and silence the tone.</p>
    </div>
  );
}

function AlignmentSession({ device, second }: { device: Device; second?: Device }) {
  const [running, setRunning] = useState(true);
  const [interval, setIntervalMs] = useState(1000);
  const [now, setNow] = useState(() => Date.now());
  const visible = useVisible();
  const active = running && visible;
  const panel = useRef<HTMLDivElement>(null);
  const [fullscreenError, setFullscreenError] = useState('');
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const a = useRadioReading(device.id, active, interval, now);
  const b = useRadioReading(second?.id, active, interval, now);
  const scope = `${device.id}:${a.selection.radio}:${a.selection.peer}:${second?.id}:${b.selection.radio}:${b.selection.peer}`;
  return (
    <div ref={panel} className="space-y-4 bg-gray-50 dark:bg-slate-900 p-1 [&:fullscreen]:p-4 [&:fullscreen]:overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
          <Activity className="w-4 h-4" />{active ? 'Live telemetry' : 'Polling paused'}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="text-xs text-gray-600 dark:text-slate-300 flex items-center gap-2">Refresh
            <select className="input w-auto" value={interval} onChange={e => setIntervalMs(Number(e.target.value))}>
              <option value={500}>500 ms</option><option value={1000}>1 second</option><option value={2000}>2 seconds</option>
            </select>
          </label>
          <button className="btn-secondary flex items-center gap-2" type="button" onClick={() => setRunning(r => !r)}>
            {running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}{running ? 'Pause' : 'Resume'}
          </button>
          {typeof document.documentElement.requestFullscreen === 'function' && <button className="btn-secondary flex items-center gap-2" type="button"
            onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : panel.current?.requestFullscreen())
              ?.catch(() => setFullscreenError('Fullscreen is unavailable in this browser.')); }}>
            <Maximize className="w-4 h-4" />Fullscreen
          </button>}
        </div>
      </div>
      {fullscreenError && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{fullscreenError}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <RadioCard device={device} reading={a} side="End A" active={active} />
        {second ? <RadioCard device={second} reading={b} side="End B" active={active} /> : <div className="card p-5 flex items-center justify-center text-sm text-gray-500 dark:text-slate-400">
          Select the other Wireless Systems device above to watch both ends of the link.
        </div>}
      </div>
      <SignalHistory key={scope} a={a.fresh ? a.peer!.signal_dbm : null} b={b.fresh ? b.peer!.signal_dbm : null}
        paired={!!second} active={active} sampleKey={a.query.data || b.query.data ? `${a.query.data?.sampled_at ?? ''}:${b.query.data?.sampled_at ?? ''}` : ''}
        time={Math.max(now, a.query.dataUpdatedAt, b.query.dataUpdatedAt)} />
    </div>
  );
}

export default function AntennaAlignerTab({ device }: { device: Device }) {
  const [secondId, setSecondId] = useState('');
  const siteId = useSiteStore(s => s.currentSiteId);
  const { data: devices = [], isError } = useQuery({
    queryKey: ['devices', siteId], queryFn: () => devicesApi.list().then(r => r.data),
  });
  const options = devices.filter(d => d.id !== device.id && canAlignAntenna(d));
  const second = options.find(d => String(d.id) === secondId);
  if (!canAlignAntenna(device)) return null;
  return (
    <div className="space-y-4">
      <div className="card p-5 space-y-3">
        <h2 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2"><Radio className="w-5 h-5" />Antenna aligner</h2>
        <p className="text-sm text-gray-600 dark:text-slate-300">Select the interface and peer at each end, then make small antenna adjustments while watching the signal and chain spread.</p>
        <label className="block text-sm text-gray-600 dark:text-slate-300">Other end of the link (optional)
          <select className="input mt-1 max-w-lg" value={secondId} onChange={e => setSecondId(e.target.value)}>
            <option value="">Local radio only</option>
            {options.map(d => <option key={d.id} value={d.id}>{d.name} — {d.ip_address} ({d.status})</option>)}
          </select>
        </label>
        {isError && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Could not load the other Wireless Systems devices.</p>}
        <p className="text-xs text-gray-500 dark:text-slate-400">Uses this Manager&apos;s saved API connection. Readings are held for up to 3 seconds and marked as old when the link drops. Polling pauses when this tab is hidden.</p>
      </div>
      <AlignmentSession key={`${device.id}:${second?.id ?? ''}:${siteId}`} device={device} second={second} />
    </div>
  );
}
