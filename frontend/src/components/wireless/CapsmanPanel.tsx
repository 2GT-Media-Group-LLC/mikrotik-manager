import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Server, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { wirelessApi, type CapsmanController } from '../../services/api';
import clsx from 'clsx';

/** One row of the unified radio/interface table. */
interface Row {
  key: string;
  deviceId: number | null;
  deviceName: string;
  local: boolean;
  interfaceName: string;
  ssid: string | null;
  channel: string | null;
  clients: number | null;
  running: boolean;
}

/**
 * Flatten a controller into one row per radio.
 *
 * Driven by the controller's radio list rather than by the CAPs' own interface rows.
 * A CAP holds no configuration — its rows report a generic name and null SSID, band
 * and frequency — whereas the controller knows the provisioned SSID, the operating
 * channel and the client count for every radio it manages.
 */
function toRows(c: CapsmanController): Row[] {
  const rows: Row[] = [];
  for (const ap of c.access_points) {
    for (const r of ap.radios) {
      rows.push({
        key: `${ap.device_id ?? ap.device_name}:${r.radio_mac}`,
        deviceId: ap.device_id,
        deviceName: ap.device_name,
        local: r.local,
        interfaceName: r.interface_name || r.radio_mac,
        ssid: r.ssid,
        channel: r.current_channel,
        clients: r.registered_peers,
        running: r.state === 'running',
      });
    }
  }
  return rows;
}

function Controller({ c }: { c: CapsmanController }) {
  const [open, setOpen] = useState(true);
  const unmanaged = c.access_points.filter((ap) => ap.device_id == null);
  const rows = toRows(c);

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left border-b border-gray-200 dark:border-slate-700"
      >
        {open ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
        <Server className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/devices/${c.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-semibold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400"
            >
              {c.name}
            </Link>
            <span className="mono text-[11px] text-gray-400">{c.ip_address}</span>
            {c.wifi_role === 'controller_cap' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium">
                controller + local radios
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">
            {c.access_points.length} access point{c.access_points.length !== 1 ? 's' : ''} ·{' '}
            {rows.length} radio{rows.length !== 1 ? 's' : ''} ·{' '}
            {c.client_count} client{c.client_count !== 1 ? 's' : ''}
          </div>
        </div>
      </button>

      {open && (
        <div className="p-4 space-y-4">
          {unmanaged.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
              <p className="text-sm text-amber-800 dark:text-amber-300">
                {unmanaged.length} access point{unmanaged.length !== 1 ? 's are' : ' is'} provisioned by this
                controller but not added to the fleet. Add {unmanaged.length !== 1 ? 'them' : 'it'} to see
                clients, health and history.
              </p>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700">
                  {['Access point', 'Interface', 'SSID', 'Channel', 'Clients', 'Status'].map((h) => (
                    <th key={h} className="table-header px-3 py-2 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {rows.map((r) => (
                  <tr key={r.key} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {r.deviceId != null ? (
                          <Link to={`/devices/${r.deviceId}`} className="text-xs font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                            {r.deviceName}
                          </Link>
                        ) : (
                          <span className="text-xs text-gray-500 dark:text-slate-400">{r.deviceName}</span>
                        )}
                        {r.local && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">local</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 mono text-xs text-gray-600 dark:text-slate-300 whitespace-nowrap">{r.interfaceName}</td>
                    <td className="px-3 py-2 text-xs font-medium text-gray-900 dark:text-white">{r.ssid || <span className="text-gray-400">—</span>}</td>
                    <td className="px-3 py-2 mono text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{r.channel || <span className="text-gray-400">—</span>}</td>
                    <td className="px-3 py-2 mono num-tab text-xs text-gray-600 dark:text-slate-300">
                      {r.clients ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={clsx(
                        'text-[10px] px-1.5 py-0.5 rounded font-medium',
                        r.running ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                      )}>
                        {r.running ? 'running' : 'idle'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {c.configurations.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-2">
                Configurations
              </div>
              <div className="flex flex-wrap gap-2">
                {c.configurations.map((cfg) => (
                  <div key={cfg.name} className="rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2 max-w-sm">
                    <div className="text-xs font-medium text-gray-900 dark:text-white">{cfg.name}</div>
                    <div className="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">
                      {[cfg.ssid && `SSID ${cfg.ssid}`, cfg.band, cfg.mode, cfg.security]
                        .filter(Boolean).join(' · ') || 'no details reported'}
                    </div>
                    {/* The rule and the configuration it applies are one idea. */}
                    {cfg.rules.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 border-t border-gray-100 dark:border-slate-700 pt-1.5">
                        {cfg.rules.map((p) => (
                          <li key={p.ros_id} className="text-[11px] text-gray-500 dark:text-slate-400">
                            <span className="mono text-gray-400">{p.action || 'rule'}</span>
                            {p.radio_mac && <span className="mono text-gray-400"> {p.radio_mac}</span>}
                            {p.disabled && <span className="text-gray-400"> · disabled</span>}
                            {p.comment && <span className="text-gray-400"> — {p.comment}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rules that reference no configuration we collected — worth surfacing
              rather than dropping, since that usually means a stale reference. */}
          {c.provisioning.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-2">
                Unmatched provisioning rules
              </div>
              <ul className="space-y-1">
                {c.provisioning.map((p) => (
                  <li key={p.ros_id} className="text-[11px] text-gray-600 dark:text-slate-300">
                    <span className="mono text-gray-400">{p.action || 'rule'}</span>
                    {p.master_configuration && <> → <span className="font-medium">{p.master_configuration}</span></>}
                    {p.radio_mac && <span className="mono text-gray-400"> ({p.radio_mac})</span>}
                    {p.comment && <span className="text-gray-400"> — {p.comment}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CapsmanPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['capsman'],
    queryFn: () => wirelessApi.capsman().then((r) => r.data),
    refetchInterval: 60_000,
  });

  const controllers = data?.controllers ?? [];
  // Invisible on a fleet with no controller rather than an empty box to scroll past.
  if (isLoading || controllers.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center">
          <Server className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">CAPsMAN</h3>
        <span className="text-[11px] text-gray-500 dark:text-slate-400">
          {controllers.length} controller{controllers.length !== 1 ? 's' : ''} · read-only
        </span>
      </div>
      <p className="text-xs text-gray-500 dark:text-slate-400">
        These access points are provisioned centrally, so their configuration lives on the controller
        rather than on the AP itself. Editing is intentionally not offered here yet: a CAPsMAN change
        applies to every bound AP at once.
      </p>
      {controllers.map((c) => <Controller key={c.id} c={c} />)}
    </div>
  );
}
