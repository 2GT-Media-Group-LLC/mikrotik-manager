import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Loader2, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { settingsApi } from '../../services/api';
import {
  BUILTIN_SERVICES, HIGHLIGHT_COLORS, highlightColors, savedServices,
  type PortService, type ServiceProto, type TrafficKind,
} from '../../utils/portServices';

/**
 * Settings → Firewall Logs (#415): the row colours for DHCP and multicast,
 * and the port names the Application column shows, laid over a built-in list.
 * Everyone sees the same; only admins change it.
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+/()-]{0,31}$/;
const KINDS: { kind: TrafficKind; label: string; help: string }[] = [
  { kind: 'dhcp', label: 'DHCP', help: 'UDP 67/68, and DHCPv6 on 546/547' },
  { kind: 'multicast', label: 'Multicast and broadcast', help: '224.0.0.0/4, ff00::/8 and 255.255.255.255' },
];

type Row = { port: string; protocol: ServiceProto; name: string };

/** "5000" or "5000-5100" (#415), as the saved entry's port and to. */
function parsePorts(text: string): { port: number; to?: number } | null {
  const parts = text.replace(/\s+/g, '').split('-');
  if (parts.length > 2 || !parts.every((x) => /^\d{1,5}$/.test(x))) return null;
  return parts.length === 1 ? { port: Number(parts[0]) } : { port: Number(parts[0]), to: Number(parts[1]) };
}

const protos = (p: ServiceProto) => (p === 'both' ? ['tcp', 'udp'] : [p]);
const toEntry = (r: Row) => ({ ...parsePorts(r.port), protocol: r.protocol, name: r.name });
const portText = (s: PortService) => (s.to === undefined ? String(s.port) : `${s.port}-${s.to}`);

/** What's wrong with a row, if anything, so Save can say before the server does. */
function rowError(r: Row, all: Row[]): string | null {
  const p = parsePorts(r.port);
  if (!p || p.port < 1 || p.port > 65535) return 'Port 1 to 65535, or a range such as 5000-5100';
  if (p.to !== undefined && (p.to <= p.port || p.to > 65535)) return 'The range must end above where it starts, up to 65535';
  if (!NAME_RE.test(r.name)) return 'Name: up to 32 letters, digits, spaces or . _ + / ( ) -';
  const shared = (o: Row) => protos(o.protocol).some((x) => protos(r.protocol).includes(x));
  for (const o of all) {
    if (o === r || !shared(o)) continue;
    const q = parsePorts(o.port);
    if (!q) continue;
    if (p.to === undefined && q.to === undefined && q.port === p.port) return 'This port is listed twice';
    // A single port inside a range names that port; two ranges can't share one.
    if (p.to !== undefined && q.to !== undefined && q.port <= p.to && p.port <= q.to) return 'This range overlaps another';
  }
  return null;
}

export default function FirewallLogSettingsCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then((r) => r.data),
  });
  const colors = highlightColors(settings?.firewall_log_colors);
  const saved = useMemo(() => savedServices(settings?.firewall_log_services), [settings]);

  // The saved list until it's edited; Save and Undo go back to following it.
  const [draft, setRows] = useState<Row[] | null>(null);
  const rows = draft ?? saved.map((s) => ({ port: portText(s), protocol: s.protocol, name: s.name }));
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [filter, setFilter] = useState('');

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => settingsApi.update(patch),
    onSuccess: (_r, patch) => {
      if ('firewall_log_services' in patch) setRows(null);
      return qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const errors = rows.map((r) => rowError(r, rows));
  const dirty = JSON.stringify(rows.map(toEntry))
    !== JSON.stringify(saved.map((s) => ({ port: s.port, ...(s.to === undefined ? {} : { to: s.to }), protocol: s.protocol, name: s.name })));
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const overridden = new Set(rows.flatMap((r) => {
    const p = parsePorts(r.port);
    if (!p || p.port < 1 || (p.to ?? p.port) > 65535) return [];
    const ports = Array.from({ length: Math.max(0, (p.to ?? p.port) - p.port + 1) }, (_, i) => p.port + i);
    return protos(r.protocol).flatMap((x) => ports.map((port) => `${x}/${port}`));
  }));
  const builtinShown = BUILTIN_SERVICES.filter((s) => !filter || String(s.port) === filter.trim() || s.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const isOverridden = (s: PortService) => protos(s.protocol).every((p) => overridden.has(`${p}/${s.port}`));

  const err = save.error as { response?: { data?: { error?: string } } } | null;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="w-4 h-4 text-blue-500" />
          <h3 className="font-semibold text-gray-900 dark:text-white">Row Colours</h3>
        </div>
        <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
          Lines of this traffic are tinted on the Firewall Logs page, so the background noise stands apart. A DHCP
          discover to 255.255.255.255 counts as DHCP. A subnet&apos;s own broadcast address (192.168.88.255, say) isn&apos;t
          recognised, because the log line doesn&apos;t carry the mask.
        </p>
        {isLoading ? <p className="text-sm text-gray-400">Loading…</p> : (
          <div className="space-y-4">
            {KINDS.map(({ kind, label, help }) => (
              <div key={kind}>
                <div className="text-sm font-medium text-gray-700 dark:text-slate-300">{label}</div>
                <div className="text-[11px] text-gray-400 dark:text-slate-500 mb-2">{help}</div>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`${label} colour`}>
                  {Object.entries(HIGHLIGHT_COLORS).map(([c, def]) => (
                    <button key={c} type="button" role="radio" aria-checked={colors[kind] === c}
                      disabled={!isAdmin || save.isPending}
                      onClick={() => save.mutate({ firewall_log_colors: { ...colors, [kind]: c } })}
                      className={clsx('flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs disabled:cursor-not-allowed',
                        colors[kind] === c
                          ? 'border-blue-500 ring-1 ring-blue-500 text-gray-900 dark:text-white'
                          : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 enabled:hover:bg-gray-50 dark:enabled:hover:bg-slate-700/40')}>
                      <span className={clsx('w-3 h-3 rounded-sm', def.swatch)} aria-hidden />
                      {def.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Port Names</h3>
        <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
          The Application column names a line&apos;s destination port (or its source port, for a reply) from a built-in
          list based on /etc/services. Add a port here to name one it doesn&apos;t know, or list one it does to name it
          your way. A range such as 5000-5100 names every port in it, and a single port listed too keeps its own name. Names for ports Traffic counts as Other TCP or Other UDP name those applications too.
        </p>

        {rows.length > 0 && (
          <div className="space-y-2 mb-3">
            {rows.map((r, i) => (
              <div key={i}>
                <div className="flex flex-wrap items-center gap-2">
                  <input className="input w-32 font-mono" placeholder="Port or range" aria-label="Port or range"
                    value={r.port} disabled={!isAdmin} onChange={(e) => setRow(i, { port: e.target.value.trim() })} />
                  <select className="input w-24" aria-label="Protocol" value={r.protocol} disabled={!isAdmin}
                    onChange={(e) => setRow(i, { protocol: e.target.value as ServiceProto })}>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                    <option value="both">Both</option>
                  </select>
                  <input className="input flex-1 min-w-32" placeholder="Name" aria-label="Name" maxLength={32}
                    value={r.name} disabled={!isAdmin} onChange={(e) => setRow(i, { name: e.target.value })} />
                  {isAdmin && (
                    <button type="button" className="btn-secondary px-2" aria-label="Remove"
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {errors[i] && r.port + r.name !== '' && (
                  <p className="text-[11.5px] text-red-600 dark:text-red-400 mt-1">{errors[i]}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary flex items-center gap-1.5"
              onClick={() => setRows([...rows, { port: '', protocol: 'tcp', name: '' }])}>
              <Plus className="w-4 h-4" /> Add a port
            </button>
            <button type="button" className="btn-primary flex items-center gap-1.5"
              disabled={!dirty || errors.some(Boolean) || save.isPending}
              onClick={() => save.mutate({
                firewall_log_services: rows.map(toEntry),
              })}>
              {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
            </button>
            {dirty && (
              <button type="button" className="text-sm text-gray-500 dark:text-slate-400 hover:underline"
                onClick={() => setRows(null)}>
                Undo changes
              </button>
            )}
          </div>
        )}
        {err?.response?.data?.error && (
          <p className="text-sm text-red-600 dark:text-red-400 mt-2">{err.response.data.error}</p>
        )}

        <button type="button" className="text-sm mt-4" style={{ color: 'var(--accent)' }} onClick={() => setShowBuiltin(!showBuiltin)}>
          {showBuiltin ? 'Hide' : 'Show'} the built-in list ({BUILTIN_SERVICES.length} ports)
        </button>
        {showBuiltin && (
          <div className="mt-2">
            <input className="input mb-2 w-full sm:w-64" placeholder="Find a port or name" aria-label="Find a port or name"
              value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="max-h-72 overflow-y-auto border border-gray-100 dark:border-slate-700 rounded-lg">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-slate-700">
                    <th className="table-header px-3 py-1.5 text-left">Port</th>
                    <th className="table-header px-3 py-1.5 text-left">Protocol</th>
                    <th className="table-header px-3 py-1.5 text-left">Name</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                  {builtinShown.map((s) => (
                    <tr key={`${s.protocol}/${s.port}`} className={clsx(isOverridden(s) && 'line-through text-gray-400 dark:text-slate-500')}>
                      <td className="px-3 py-1 font-mono">{s.port}</td>
                      <td className="px-3 py-1 uppercase">{s.protocol === 'both' ? 'TCP, UDP' : s.protocol}</td>
                      <td className="px-3 py-1 font-mono">{s.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">Struck out: named your way above.</p>
          </div>
        )}
      </div>
    </div>
  );
}
