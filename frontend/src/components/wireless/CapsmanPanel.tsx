import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Radio, RefreshCw, Server, Wifi, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { wirelessApi, type CapsmanController } from '../../services/api';
import clsx from 'clsx';

/**
 * CAPsMAN controllers and the access points they provision.
 *
 * Read-only by design. A CAPsMAN configuration is applied to every AP bound to it,
 * so an edit here would change the whole wireless fleet at once — that needs the
 * same prediction-and-revert treatment device changes get, and is held back until
 * it does (issue #94).
 */
function Controller({ c }: { c: CapsmanController }) {
  const [open, setOpen] = useState(true);
  const unmanaged = c.access_points.filter((ap) => ap.device_id == null);
  const radioCount = c.access_points.reduce((n, ap) => n + ap.radios.length, 0);

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
            {radioCount} radio{radioCount !== 1 ? 's' : ''} ·{' '}
            {c.client_count} client{c.client_count !== 1 ? 's' : ''} ·{' '}
            {c.configurations.length} configuration{c.configurations.length !== 1 ? 's' : ''}
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

          {/* Radios grouped by the AP they physically live on */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-2">
              Access points
            </div>
            <div className="space-y-2">
              {c.access_points.map((ap, i) => (
                <div key={ap.device_id ?? `u${i}`} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Wifi className="w-3.5 h-3.5 text-gray-400" />
                    {ap.device_id != null ? (
                      <Link to={`/devices/${ap.device_id}`} className="text-sm font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                        {ap.device_name}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-gray-500 dark:text-slate-400">{ap.device_name}</span>
                    )}
                    {ap.radios[0]?.local && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">on controller</span>
                    )}
                    <span className="ml-auto text-[11px] text-gray-500 dark:text-slate-400">
                      {ap.client_count} client{ap.client_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ap.radios.map((r) => (
                      <div key={r.radio_mac} className="flex items-center gap-1.5 text-[11px] rounded px-2 py-1 bg-gray-50 dark:bg-slate-800">
                        <Radio className={clsx('w-3 h-3', r.state === 'running' ? 'text-green-500' : 'text-gray-400')} />
                        <span className="font-medium text-gray-700 dark:text-slate-200">{r.interface_name || r.radio_mac}</span>
                        {r.current_channel && <span className="mono text-gray-500 dark:text-slate-400">{r.current_channel}</span>}
                        {r.registered_peers != null && (
                          <span className="text-gray-500 dark:text-slate-400">{r.registered_peers} client{r.registered_peers !== 1 ? 's' : ''}</span>
                        )}
                        {r.tx_power != null && <span className="text-gray-400">{r.tx_power} dBm</span>}
                        {r.hw_type && <span className="text-gray-400 hidden sm:inline">{r.hw_type}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Provisioned SSIDs actually broadcasting */}
          {c.ssids.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-2">
                Provisioned interfaces
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700">
                      {['Access point', 'Interface', 'SSID', 'Band', ''].map((h, i) => (
                        <th key={i} className="table-header px-3 py-2 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                    {c.ssids.map((s, i) => (
                      <tr key={`${s.device_id}:${s.name}:${i}`}>
                        <td className="px-3 py-2 text-xs text-gray-700 dark:text-slate-200">{s.device_name}</td>
                        <td className="px-3 py-2 mono text-xs text-gray-500 dark:text-slate-400">{s.name}</td>
                        <td className="px-3 py-2 text-xs font-medium text-gray-900 dark:text-white">{s.ssid || '—'}</td>
                        <td className="px-3 py-2 mono text-xs text-gray-500 dark:text-slate-400">
                          {s.band || '—'}{s.frequency ? ` · ${s.frequency}` : ''}
                        </td>
                        <td className="px-3 py-2">
                          <span className={clsx(
                            'text-[10px] px-1.5 py-0.5 rounded font-medium',
                            s.disabled ? 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
                                       : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          )}>
                            {s.disabled ? 'disabled' : 'active'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Configurations and the rules binding them to radios */}
          {c.configurations.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-2">
                Configurations
              </div>
              <div className="flex flex-wrap gap-2">
                {c.configurations.map((cfg) => (
                  <div key={cfg.name} className="rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                    <div className="text-xs font-medium text-gray-900 dark:text-white">{cfg.name}</div>
                    <div className="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">
                      {[cfg.ssid && `SSID ${cfg.ssid}`, cfg.band, cfg.mode, cfg.security]
                        .filter(Boolean).join(' · ') || 'no details reported'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {c.provisioning.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-2">
                Provisioning rules
              </div>
              <ul className="space-y-1">
                {c.provisioning.map((p) => (
                  <li key={p.ros_id} className="text-[11px] text-gray-600 dark:text-slate-300">
                    <span className="mono text-gray-400">{p.action || 'rule'}</span>
                    {p.master_configuration && <> → <span className="font-medium">{p.master_configuration}</span></>}
                    {p.radio_mac && <span className="mono text-gray-400"> ({p.radio_mac})</span>}
                    {p.disabled && <span className="ml-1 text-gray-400">· disabled</span>}
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
  // Nothing to show on a fleet with no controller — this panel should be invisible
  // rather than an empty box everyone has to scroll past.
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
