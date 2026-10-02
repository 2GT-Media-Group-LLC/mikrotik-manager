import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, Loader2, CheckCircle, XCircle, Wifi, RotateCcw, Download, Activity } from 'lucide-react';
import { deviceToolsApi, devicesApi } from '../../services/api';
import clsx from 'clsx';
import { useCanWrite } from '../../hooks/useCanWrite';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function RunButton({ loading, onClick, label = 'Run' }: { loading: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="btn-primary flex items-center gap-2 shrink-0"
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
      {loading ? 'Running…' : label}
    </button>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
      <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
      {message}
    </div>
  );
}

function ResultTable({ headers, rows }: { headers: string[]; rows: (string | null)[][] }) {
  if (!rows.length) return <p className="text-sm text-gray-400 dark:text-slate-500">No results.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-gray-200 dark:border-slate-700">
            {headers.map((h) => (
              <th key={h} className="px-3 py-1.5 text-left text-gray-500 dark:text-slate-400 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50 table-zebra">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-700/20">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-1.5 text-gray-700 dark:text-slate-300">{cell ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Ping ─────────────────────────────────────────────────────────────────────

function PingTool({ deviceId, interfaces }: { deviceId: number; interfaces: string[] }) {
  const [address, setAddress] = useState('');
  const [count, setCount] = useState('4');
  const [iface, setIface] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Record<string, string>[] | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    if (!address) return;
    setLoading(true); setError(''); setResults(null);
    try {
      const { data } = await deviceToolsApi.ping(deviceId, {
        address,
        count: parseInt(count) || 4,
        interface: iface || undefined,
      });
      setResults(data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || (e as Error).message || 'Ping failed');
    } finally {
      setLoading(false);
    }
  };

  // Split results into per-packet rows and summary (last row has packet-loss)
  const packets = results?.filter((r) => r['seq'] !== undefined) ?? [];
  const summary = results?.find((r) => r['sent'] !== undefined);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <input
          className="input flex-1 min-w-48"
          placeholder="IP address or hostname"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <input
          className="input w-20"
          type="number"
          min={1}
          max={20}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          title="Packet count"
        />
        {interfaces.length > 0 && (
          <select className="input w-44" value={iface} onChange={(e) => setIface(e.target.value)}>
            <option value="">Any interface</option>
            {interfaces.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        )}
        <RunButton loading={loading} onClick={run} />
      </div>

      {error && <ErrorBox message={error} />}

      {results && (
        <div className="space-y-3">
          <ResultTable
            headers={['Seq', 'Host', 'Time', 'TTL', 'Size', 'Status']}
            rows={packets.map((r) => [
              r['seq'] ?? null,
              r['host'] ?? null,
              r['time'] ? `${r['time']}ms` : null,
              r['ttl'] ?? null,
              r['size'] ? `${r['size']}B` : null,
              r['status'] || (r['time'] ? 'OK' : 'timeout'),
            ])}
          />
          {summary && (
            <div className="flex flex-wrap gap-4 p-3 bg-gray-50 dark:bg-slate-700/40 rounded-lg text-xs font-mono text-gray-600 dark:text-slate-400">
              <span>Sent: <b className="text-gray-900 dark:text-white">{summary['sent']}</b></span>
              <span>Received: <b className="text-gray-900 dark:text-white">{summary['received']}</b></span>
              <span>Loss: <b className={clsx(
                summary['packet-loss'] === '0%' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
              )}>{summary['packet-loss']}</b></span>
              {summary['avg-rtt'] && <span>Avg RTT: <b className="text-gray-900 dark:text-white">{summary['avg-rtt']}ms</b></span>}
              {summary['min-rtt'] && <span>Min: <b className="text-gray-900 dark:text-white">{summary['min-rtt']}ms</b></span>}
              {summary['max-rtt'] && <span>Max: <b className="text-gray-900 dark:text-white">{summary['max-rtt']}ms</b></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Traceroute ───────────────────────────────────────────────────────────────

function TracerouteTool({ deviceId }: { deviceId: number }) {
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Record<string, string>[] | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    if (!address) return;
    setLoading(true); setError(''); setResults(null);
    try {
      const { data } = await deviceToolsApi.traceroute(deviceId, { address });
      setResults(data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || (e as Error).message || 'Traceroute failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <input
          className="input flex-1"
          placeholder="IP address or hostname"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <RunButton loading={loading} onClick={run} />
      </div>
      {loading && (
        <p className="text-sm text-gray-500 dark:text-slate-400">Tracing route — this may take up to 60 seconds…</p>
      )}
      {error && <ErrorBox message={error} />}
      {results && (
        <ResultTable
          headers={['Hop', 'Address', 'Status', 'Loss', 'Sent', 'Last', 'Avg', 'Best', 'Worst']}
          rows={results.map((r, i) => [
            String(i + 1),
            r['address'] || r['host'] || '* * *',
            r['status'] || '',
            r['loss'] ?? null,
            r['sent'] ?? null,
            r['last'] ? `${r['last']}ms` : null,
            r['avg'] ? `${r['avg']}ms` : null,
            r['best'] ? `${r['best']}ms` : null,
            r['worst'] ? `${r['worst']}ms` : null,
          ])}
        />
      )}
    </div>
  );
}

// ─── IP Scan ──────────────────────────────────────────────────────────────────

function IpScanTool({ deviceId, interfaces }: { deviceId: number; interfaces: string[] }) {
  const [addressRange, setAddressRange] = useState('');
  const [iface, setIface] = useState(interfaces[0] || '');
  const [rdns, setRdns] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Record<string, string>[] | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    if (!addressRange || !iface) return;
    setLoading(true); setError(''); setResults(null);
    try {
      const { data } = await deviceToolsApi.ipScan(deviceId, { addressRange, interface: iface, rdns });
      setResults(data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || (e as Error).message || 'IP scan failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <input
          className="input flex-1 min-w-48"
          placeholder="Address range (e.g. 192.168.1.0/24)"
          value={addressRange}
          onChange={(e) => setAddressRange(e.target.value)}
        />
        <select className="input w-44" value={iface} onChange={(e) => setIface(e.target.value)}>
          <option value="">Select interface…</option>
          {interfaces.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={rdns}
            onChange={(e) => setRdns(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 dark:border-slate-600 text-blue-600 cursor-pointer"
          />
          Reverse DNS
        </label>
        <RunButton loading={loading} onClick={run} label="Scan" />
      </div>
      {loading && (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Scanning{rdns ? ' + resolving hostnames' : ''} — results appear when scan completes…
        </p>
      )}
      {error && <ErrorBox message={error} />}
      {results && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 dark:text-slate-400">{results.length} host{results.length !== 1 ? 's' : ''} found</p>
          <ResultTable
            headers={rdns ? ['IP Address', 'Hostname', 'MAC Address'] : ['IP Address', 'MAC Address']}
            rows={results.map((r) =>
              rdns
                ? [r['address'] ?? null, r['hostname'] || '—', r['mac-address'] ?? null]
                : [r['address'] ?? null, r['mac-address'] ?? null]
            )}
          />
        </div>
      )}
    </div>
  );
}

// ─── Wake-on-LAN ──────────────────────────────────────────────────────────────

function WolTool({ deviceId, interfaces }: { deviceId: number; interfaces: string[] }) {
  const [mac, setMac] = useState('');
  const [iface, setIface] = useState(interfaces[0] || '');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const run = async () => {
    if (!mac || !iface) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const { data } = await deviceToolsApi.wol(deviceId, { mac, interface: iface });
      setSuccess(data.message || 'Magic packet sent successfully');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || (e as Error).message || 'WoL failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <input
          className="input flex-1 min-w-48"
          placeholder="MAC address (e.g. AA:BB:CC:DD:EE:FF)"
          value={mac}
          onChange={(e) => setMac(e.target.value)}
        />
        <select className="input w-44" value={iface} onChange={(e) => setIface(e.target.value)}>
          <option value="">Select interface…</option>
          {interfaces.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <RunButton loading={loading} onClick={run} label="Send Packet" />
      </div>
      {error && <ErrorBox message={error} />}
      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-300">
          <CheckCircle className="w-4 h-4 shrink-0" />
          {success}
        </div>
      )}
    </div>
  );
}

// ─── Reboot ───────────────────────────────────────────────────────────────────

function RebootSection({ deviceId }: { deviceId: number }) {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const run = async () => {
    if (!confirm('Are you sure you want to reboot this device? It will be temporarily unreachable.')) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const { data } = await devicesApi.reboot(deviceId);
      setSuccess(data.message || 'Reboot command sent.');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || (e as Error).message || 'Reboot failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <RotateCcw className="w-4 h-4 text-orange-500 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Reboot Device</h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
              Sends a reboot command to the device. It will be briefly unreachable while restarting.
            </p>
          </div>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="btn-secondary flex items-center gap-2 shrink-0 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800 hover:bg-orange-50 dark:hover:bg-orange-900/20"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          {loading ? 'Rebooting…' : 'Reboot'}
        </button>
      </div>
      {error && <div className="mt-3"><ErrorBox message={error} /></div>}
      {success && (
        <div className="flex items-center gap-2 mt-3 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-300">
          <CheckCircle className="w-4 h-4 shrink-0" />
          {success}
        </div>
      )}
    </div>
  );
}

// ─── Packet Capture ───────────────────────────────────────────────────────────

function PacketCaptureTool({ deviceId, interfaces }: { deviceId: number; interfaces: string[] }) {
  const [iface, setIface] = useState(interfaces[0] || '');
  const [filterIp, setFilterIp] = useState('');
  const [duration, setDuration] = useState('10');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [fileName, setFileName] = useState('');
  // Release the capture's memory when it's replaced or the panel closes (U12).
  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);

  const run = async () => {
    setLoading(true); setError(''); setReady(false);
    try {
      const res = await deviceToolsApi.capture(deviceId, {
        interface: iface || undefined,
        filter_ip: filterIp.trim() || undefined,
        duration: parseInt(duration) || 10,
      });
      const blob = new Blob([res.data as BlobPart], { type: 'application/vnd.tcpdump.pcap' });
      const url = URL.createObjectURL(blob);
      const name = `capture-${deviceId}-${Date.now()}.pcap`;
      setDownloadUrl(url);
      setFileName(name);
      setReady(true);
    } catch (e: unknown) {
      // responseType:'blob' means error bodies arrive as Blobs — parse them back to text
      const blobData = (e as { response?: { data?: unknown } })?.response?.data;
      if (blobData instanceof Blob) {
        try {
          const text = await blobData.text();
          const json = JSON.parse(text) as { error?: string };
          setError(json.error || text || 'Capture failed');
        } catch {
          setError('Capture failed');
        }
      } else {
        const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setError(msg || (e as Error).message || 'Capture failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-slate-400">
        Captures packets using the RouterOS sniffer and downloads a PCAP file you can open in Wireshark.
        Requires SSH credentials on the device.
      </p>
      <div className="flex flex-wrap gap-3">
        {interfaces.length > 0 && (
          <select className="input w-44" value={iface} onChange={(e) => setIface(e.target.value)}>
            <option value="">All interfaces</option>
            {interfaces.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        )}
        <input
          className="input flex-1 min-w-36"
          placeholder="Filter IP (optional)"
          value={filterIp}
          onChange={(e) => setFilterIp(e.target.value)}
        />
        <select className="input w-28" value={duration} onChange={(e) => setDuration(e.target.value)}>
          {[5, 10, 15, 30, 60].map((s) => <option key={s} value={s}>{s}s</option>)}
        </select>
        <RunButton loading={loading} onClick={run} label="Capture" />
      </div>
      {loading && (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Capturing for {duration}s — please wait…
        </p>
      )}
      {error && <ErrorBox message={error} />}
      {ready && downloadUrl && (
        <a
          href={downloadUrl}
          download={fileName}
          className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Download className="w-4 h-4" />
          Download {fileName}
        </a>
      )}
    </div>
  );
}

// ─── Bandwidth Test ───────────────────────────────────────────────────────────

function BandwidthTestTool({ deviceId }: { deviceId: number }) {
  // 'managed' = pick a device from inventory; 'manual' = type an IP (server must be pre-enabled)
  const [mode, setMode] = useState<'managed' | 'manual'>('managed');
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [manualAddress, setManualAddress] = useState('');
  const [direction, setDirection] = useState('both');
  const [duration, setDuration] = useState('5');
  const [protocol, setProtocol] = useState('tcp');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ tx_mbps: number; rx_mbps: number; direction: string; protocol: string; duration: number; target_ip: string } | null>(null);

  const { data: allDevices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
  });

  // Exclude the current device from the target list
  const targetDevices = allDevices.filter((d: { id: number; status?: string }) => d.id !== deviceId);

  const canRun = mode === 'managed' ? !!targetDeviceId : !!manualAddress.trim();

  const run = async () => {
    if (!canRun) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const body = mode === 'managed'
        ? { target_device_id: parseInt(targetDeviceId), direction, duration: parseInt(duration), protocol }
        : { address: manualAddress.trim(), direction, duration: parseInt(duration), protocol };
      const { data } = await deviceToolsApi.btest(deviceId, body);
      setResult(data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || (e as Error).message || 'Bandwidth test failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-slate-400">
        Measures throughput between this device (client) and a target (server). When targeting a managed
        device, the bandwidth-test server is automatically enabled and disabled for you.
      </p>

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode('managed')}
          className={clsx('px-3 py-1 rounded text-xs font-medium border transition-colors', mode === 'managed'
            ? 'bg-blue-600 text-white border-blue-600'
            : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:border-blue-400')}
        >
          Managed device
        </button>
        <button
          onClick={() => setMode('manual')}
          className={clsx('px-3 py-1 rounded text-xs font-medium border transition-colors', mode === 'manual'
            ? 'bg-blue-600 text-white border-blue-600'
            : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:border-blue-400')}
        >
          Manual IP
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        {mode === 'managed' ? (
          <select className="input flex-1 min-w-48" value={targetDeviceId} onChange={(e) => setTargetDeviceId(e.target.value)}>
            <option value="">— Select target device —</option>
            {targetDevices.map((d: { id: number; name: string; ip_address: string; status?: string }) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.ip_address}){d.status === 'offline' ? ' — offline' : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input flex-1 min-w-48"
            placeholder="Target IP address"
            value={manualAddress}
            onChange={(e) => setManualAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
          />
        )}
        <select className="input w-32" value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="both">Both</option>
          <option value="receive">Receive</option>
          <option value="transmit">Transmit</option>
        </select>
        <select className="input w-24" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
        <select className="input w-24" value={duration} onChange={(e) => setDuration(e.target.value)}>
          {[5, 10, 15, 30].map((s) => <option key={s} value={s}>{s}s</option>)}
        </select>
        <RunButton loading={loading} onClick={run} label="Test" />
      </div>

      {mode === 'manual' && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Manual mode: ensure the bandwidth-test server is running on the target device before starting.
        </p>
      )}

      {loading && (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Running {duration}s bandwidth test — please wait…
        </p>
      )}
      {error && <ErrorBox message={error} />}
      {result && (
        <div className="grid grid-cols-2 gap-3">
          {(result.direction === 'both' || result.direction === 'transmit') && (
            <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-center">
              <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">{result.tx_mbps} Mbps</div>
              <div className="text-xs text-blue-500 dark:text-blue-400 mt-1">TX (Upload to {result.target_ip})</div>
            </div>
          )}
          {(result.direction === 'both' || result.direction === 'receive') && (
            <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-center">
              <div className="text-2xl font-bold text-green-700 dark:text-green-300">{result.rx_mbps} Mbps</div>
              <div className="text-xs text-green-500 dark:text-green-400 mt-1">RX (Download from {result.target_ip})</div>
            </div>
          )}
          <div className="col-span-2 text-xs text-gray-500 dark:text-slate-400 text-center">
            {result.duration}s {result.protocol.toUpperCase()} test
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

function ToolCard({ title, icon: Icon, children }: { title: string; icon: React.FC<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

export default function ToolsTab({ deviceId }: { deviceId: number }) {
  const canWrite = useCanWrite();
  const { data: ifaceData = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data),
  });

  const interfaceNames = ifaceData.map((i: { name: string }) => i.name).filter(Boolean);

  return (
    <div className="space-y-4">
      {canWrite && <RebootSection deviceId={deviceId} />}

      {/* Run on the device, so the server requires write access (U10). */}
      {canWrite && (<>
      <ToolCard title="Ping" icon={({ className }) => (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          <path d="M5.636 5.636l2.122 2.122M16.243 16.243l2.121 2.121M5.636 18.364l2.122-2.122M16.243 7.757l2.121-2.121" />
        </svg>
      )}>
        <PingTool deviceId={deviceId} interfaces={interfaceNames} />
      </ToolCard>

      <ToolCard title="Traceroute" icon={({ className }) => (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      )}>
        <TracerouteTool deviceId={deviceId} />
      </ToolCard>

      <ToolCard title="IP Scan" icon={({ className }) => (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
          <circle cx="12" cy="10" r="3" /><path d="M6 10h.01M18 10h.01" />
        </svg>
      )}>
        <IpScanTool deviceId={deviceId} interfaces={interfaceNames} />
      </ToolCard>

      </>)}

      {canWrite && (
        <ToolCard title="Wake-on-LAN" icon={Wifi}>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
            Sends a WoL magic packet from this MikroTik device to wake a sleeping host on the network.
          </p>
          <WolTool deviceId={deviceId} interfaces={interfaceNames} />
        </ToolCard>
      )}

      {canWrite && (
        <ToolCard title="Packet Capture" icon={Download}>
          <PacketCaptureTool deviceId={deviceId} interfaces={interfaceNames} />
        </ToolCard>
      )}

      {canWrite && (
        <ToolCard title="Bandwidth Test" icon={Activity}>
          <BandwidthTestTool deviceId={deviceId} />
        </ToolCard>
      )}
    </div>
  );
}
