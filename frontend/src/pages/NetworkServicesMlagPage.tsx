import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useFleetRefresh } from '../hooks/useFleetRefresh';
import { mlagApi, type MlagBondSide, type MlagBondView, type MlagBridgeView, type MlagPairView, type MlagPeerMember, type MlagPeerLinkSide, type MlagPeerLinkView } from '../services/api';
import { useDateTimeFormat } from '../hooks/useDateTimeFormat';

const list = (v: string | null | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }) {
  return (
    <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', {
      good: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      bad: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      muted: 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400',
    }[tone])}>{children}</span>
  );
}

function Peer({ p, link }: { p: MlagBridgeView; link: MlagBondView | null }) {
  const active = list(link?.active_ports);
  const total = active.length + list(link?.inactive_ports).length;
  return (
    <div className="flex-1 min-w-0 rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Link to={`/devices/${p.device_id}`} className="font-medium text-blue-600 dark:text-blue-400 hover:underline">{p.device_name}</Link>
        <Pill tone={p.mlag_state === 'connected' ? 'good' : 'bad'}>{p.mlag_state ?? 'no state'}</Pill>
        {p.mlag_role && <Pill tone="muted">{p.mlag_role}</Pill>}
      </div>
      <div className="text-xs text-gray-500 dark:text-slate-400 space-y-0.5">
        <div>Bridge <span className="font-mono">{p.bridge_name}</span> · priority {p.mlag_priority ?? '—'} · RouterOS {p.ros_version ?? '—'}</div>
        <div>
          Peer link <span className="font-mono">{p.mlag_peer_port}</span>
          {link ? <> · {link.running ? `${active.length} of ${total || active.length} up` : <span className="text-red-600 dark:text-red-400">down</span>}</> : ' · not read yet'}
        </div>
        <div>Heartbeat {p.mlag_heartbeat ?? '—'} · init delay {p.mlag_init_delay ?? '—'} · LACP fallback {p.mlag_lacp_fallback == null ? '—' : p.mlag_lacp_fallback ? 'yes' : 'no'}</div>
      </div>
    </div>
  );
}

function Side({ s }: { s: MlagBondSide | null }) {
  if (!s) return <span className="text-gray-400">not set up</span>;
  return (
    <span className="font-mono text-xs">
      {s.bond} <span className={s.running ? 'text-green-600 dark:text-green-400' : s.everUp ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}>
        {s.running ? 'up' : s.everUp ? 'down' : 'not cabled'}
      </span>
      {s.active.length > 0 && <span className="text-gray-400"> · {s.active.join(', ')}</span>}
      {s.inactive.length > 0 && <span className="text-amber-600 dark:text-amber-400"> · {s.inactive.join(', ')} inactive</span>}
    </span>
  );
}

// unused: set up for a switch not cabled yet, never seen up (#376).
function MemberCell({ m }: { m: MlagPeerMember | null }) {
  if (!m) return <span className="text-gray-400">—</span>;
  return (
    <span className="font-mono text-xs">
      {m.name}{' '}
      <span className={!m.running ? 'text-red-600 dark:text-red-400' : m.active ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}>
        {!m.running ? 'down' : m.active ? 'up' : 'up, not active'}
      </span>
    </span>
  );
}

/** Both ends' values, or one when they agree. */
const both = (a: string | number | null | undefined, b: string | number | null | undefined) => {
  const x = a ?? '—';
  const y = b ?? '—';
  return x === y ? String(x) : `${x} / ${y}`;
};

/**
 * The peer link in detail (#376): the most important link of the pair, and
 * the first thing to look at when MLAG goes wrong.
 */
function PeerLinkBlock({ pair, view }: { pair: MlagPairView; view: MlagPeerLinkView }) {
  const { formatDateTime } = useDateTimeFormat();
  const { a, b } = pair;
  const missing = [...new Set([...(a.mlag_missing_vlans ?? []), ...(b?.mlag_missing_vlans ?? [])])].sort((x, y) => x - y);
  const vlans = [...new Set([...(view.a?.vlans ?? []), ...(view.b?.vlans ?? [])])].sort((x, y) => x - y);
  const partnerLine = (s: MlagPeerLinkSide | null, me: string, other: string | undefined) => {
    if (!s) return null;
    return (
      <span className={s.partnerOk === false ? 'text-red-600 dark:text-red-400' : ''}>
        {me} sees <span className="font-mono">{s.partner ?? 'no partner'}</span>
        {s.partnerOk === true && <span className="text-green-600 dark:text-green-400"> ✓ {other}</span>}
        {s.partnerOk === false && <> ✗ not {other}: crossed cabling?</>}
      </span>
    );
  };
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700">
      <div className="px-3 py-2 border-b border-gray-200 dark:border-slate-700 text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">
        Peer link <span className="font-mono normal-case">{view.a?.bond ?? a.mlag_peer_port}{view.b && view.b.bond !== view.a?.bond ? ` / ${view.b.bond}` : ''}</span>
      </div>
      {view.members.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-gray-100 dark:border-slate-700">
                {['#', a.device_name, b?.device_name ?? 'Peer', 'Speed', 'Link-downs', 'Errors (24h)'].map((h) => <th key={h} className="table-header px-3 py-1.5">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {view.members.map((row, i) => {
                const errors = (row.a?.errors24h ?? 0) + (row.b?.errors24h ?? 0);
                return (
                  <tr key={i}>
                    <td className="px-3 py-1.5 text-xs text-gray-400">{i + 1}</td>
                    <td className="px-3 py-1.5"><MemberCell m={row.a} /></td>
                    <td className="px-3 py-1.5"><MemberCell m={row.b} /></td>
                    <td className="px-3 py-1.5 text-xs">{both(row.a?.speed, row.b?.speed)}</td>
                    <td className="px-3 py-1.5 text-xs">{both(row.a?.linkDowns, row.b?.linkDowns)}</td>
                    <td className={clsx('px-3 py-1.5 text-xs', errors > 0 && 'text-amber-600 dark:text-amber-400')}>{both(row.a?.errors24h, row.b?.errors24h)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-3 py-2 text-xs text-gray-600 dark:text-slate-300 space-y-1 border-t border-gray-100 dark:border-slate-700">
        <div>
          <span className="text-gray-400">VLANs carried: </span>
          {vlans.length ? vlans.map((v, i) => (
            <span key={v}>{i > 0 && ', '}<span className={v === 1 ? 'font-semibold' : ''}>{v}</span></span>
          )) : 'none read yet'}
          {vlans.length > 0 && !vlans.includes(1) && <span className="text-amber-600 dark:text-amber-400"> · VLAN 1 isn&apos;t tagged, and host sync needs it</span>}
          {missing.length > 0 && <span className="text-amber-600 dark:text-amber-400"> · missing: {missing.join(', ')} (on MLAG bonds)</span>}
        </div>
        {(view.a || view.b) && (
          <div className="flex flex-wrap gap-x-4">
            <span className="text-gray-400">LACP partner:</span>
            {partnerLine(view.a, a.device_name, b?.device_name)}
            {b && partnerLine(view.b, b.device_name, a.device_name)}
          </div>
        )}
        <div>
          <span className="text-gray-400">Last flap: </span>
          {view.lastFlap ? <>{view.lastFlap.member} on {view.lastFlap.device}, {formatDateTime(view.lastFlap.at)}</> : 'none in the last 7 days'}
        </div>
      </div>
    </div>
  );
}

const BOND_TONE = { 'dual-homed': 'good', 'single-homed': 'warn', mismatch: 'bad', down: 'bad', unused: 'muted' } as const;

function PairCard({ pair }: { pair: MlagPairView }) {
  const { a, b } = pair;
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <Link2 className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{b ? `${a.device_name} + ${b.device_name}` : a.device_name}</h3>
        <span className="ml-auto"><Pill tone={pair.status === 'healthy' ? 'good' : pair.status === 'warning' ? 'warn' : 'bad'}>{pair.status}</Pill></span>
      </div>
      <div className="p-5 space-y-4">
        <div className="flex flex-col md:flex-row gap-3">
          <Peer p={a} link={pair.peerLinkA} />
          {b ? <Peer p={b} link={pair.peerLinkB} /> : (
            <div className="flex-1 rounded-lg border border-dashed border-gray-300 dark:border-slate-600 p-3 text-xs text-gray-500 dark:text-slate-400">
              Peer not found among managed devices.
            </div>
          )}
        </div>

        {pair.peerLink && <PeerLinkBlock pair={pair} view={pair.peerLink} />}

        <div className="space-y-1.5">
          {pair.findings.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"><CheckCircle2 className="w-4 h-4" />Every check passes.</div>
          ) : pair.findings.map((f, i) => (
            <div key={i} className={clsx('flex items-start gap-2 text-sm', f.severity === 'critical' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400')}>
              {f.severity === 'critical' ? <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
              <span>{f.text}</span>
            </div>
          ))}
        </div>

        {pair.bonds.length > 0 && (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-gray-200 dark:border-slate-700 text-left">
                  {['mlag-id', 'Downstream (LACP partner)', a.device_name, b?.device_name ?? 'Peer', 'State'].map((h) => (
                    <th key={h} className="table-header px-5 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {pair.bonds.map((r) => {
                  const partner = r.a ?? r.b;
                  return (
                    <tr key={r.mlagId}>
                      <td className="px-5 py-2 font-mono text-xs">{r.mlagId}</td>
                      <td className="px-5 py-2 text-xs">{partner?.partnerName ?? <span className="font-mono text-gray-500">{partner?.partner ?? '—'}</span>}</td>
                      <td className="px-5 py-2"><Side s={r.a} /></td>
                      <td className="px-5 py-2"><Side s={r.b} /></td>
                      <td className="px-5 py-2"><Pill tone={BOND_TONE[r.status]}>{r.status}</Pill></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * MLAG pairs across the fleet (#376): each pair's state and roles, the peer
 * link, the MLAG bonds side by side, and health checks for what has gone wrong
 * on real pairs. Read-only, from the slow polls and the logs.
 */
export default function NetworkServicesMlagPage() {
  const { data: pairs = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['mlag'],
    queryFn: () => mlagApi.pairs().then((r) => r.data),
    refetchInterval: 60_000,
  });
  const { refresh, refreshing } = useFleetRefresh(['slow'], refetch);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">MLAG</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            MLAG pairs, their peer link and bonds, and what looks wrong, refreshed with each slow poll and from the
            devices&apos; logs. Read-only. Turn on the <Link to="/settings?tab=alerting" className="text-blue-600 dark:text-blue-400 hover:underline">MLAG degraded</Link> alert to hear about critical problems.
          </p>
        </div>
        <button onClick={() => void refresh()} disabled={isFetching || refreshing} className="btn-secondary flex items-center gap-2 text-sm flex-shrink-0">
          <RefreshCw className={clsx('w-3.5 h-3.5', (isFetching || refreshing) && 'animate-spin')} /> Refresh
        </button>
      </div>
      {isLoading ? <div className="card py-10 text-center text-gray-400">Loading…</div>
        : pairs.length === 0 ? (
          <div className="card py-10 text-center text-gray-400 dark:text-slate-500">
            No MLAG found. A bridge with an MLAG peer port appears here after its next slow poll.
          </div>
        ) : pairs.map((p) => <PairCard key={`${p.a.device_id}-${p.b?.device_id ?? ''}`} pair={p} />)}
    </div>
  );
}
