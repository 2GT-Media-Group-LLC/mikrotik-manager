import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Layers, Pencil, Plus, Power, Trash2, X } from 'lucide-react';
import { zonesApi, type ZonePlan, type ZonePolicy, type ZoneRequest, type ZonesData } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import ReviewChangesButton from '../common/ReviewChangesButton';
import {
  ROUTER, pairKey, draftErrors, policySummary, initialDraft, addZone, removeZone, setPolicy, zoneNameError, customError, protocolName,
} from '../../utils/zones';

const errMsg = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error)?.message || 'That didn’t work';

/**
 * Zone-based firewall (#369): interface lists as zones, and a matrix of what
 * each zone may reach, compiled into the whole IPv4 filter table.
 */
export default function ZonesCard({ deviceId, deviceName, onApplied }: { deviceId: number; deviceName?: string; onApplied: () => void }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const { formatDateTime } = useDateTimeFormat();
  const { data, isLoading, error } = useQuery({
    queryKey: ['firewall-zones', deviceId], queryFn: () => zonesApi.get(deviceId).then((r) => r.data), retry: false,
  });
  const [setup, setSetup] = useState(false);
  const [draft, setDraft] = useState<ZoneRequest | null>(null);
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const base = useMemo(() => (data ? initialDraft(data) : null), [data]);
  const current = draft ?? base;
  const editing = !!data && !!current && canWrite && (data.enabled || setup);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(base);

  const localErrors = current ? draftErrors(current) : {};
  const clean = Object.keys(localErrors).length === 0;
  const planBody = useDebouncedValue(current, 500);
  const plan = useQuery({
    queryKey: ['zone-plan', deviceId, JSON.stringify(planBody)],
    queryFn: () => zonesApi.plan(deviceId, planBody!).then((r) => r.data),
    enabled: editing && !!planBody && clean && (dirty || setup || !!data?.drift),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const errors = { ...(clean ? plan.data?.errors ?? {} : {}), ...localErrors };

  const guard = useGuardedWrite();
  const fail = (e: unknown) => setFailure(errMsg(e));
  const done = (msg: string) => {
    setMessage(msg); setFailure(''); setDraft(null); setSetup(false);
    qc.invalidateQueries({ queryKey: ['firewall-zones', deviceId] });
    onApplied();
  };
  const applyMut = useMutation({
    mutationFn: (confirm: boolean) => zonesApi.apply(deviceId, current!, confirm),
    onSuccess: (res) => { guard.onSuccess(res); done(res.data.message); },
  });
  const apply = () => applyMut.mutate(false, { onError: guard.onError(() => applyMut.mutate(true, { onError: fail }), fail) });
  const offMut = useMutation({ mutationFn: () => zonesApi.turnOff(deviceId), onSuccess: (res) => done(res.data.message), onError: fail });

  if (isLoading) return null;
  if (error || !data) return null;

  const header = (
    <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 text-left">
      <div className="w-7 h-7 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center"><Layers className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /></div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Zones</h3>
      {data.enabled
        ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">On</span>
        : <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">Off</span>}
      {data.enabled && data.applied_at && (
        <span className="text-xs text-gray-400 dark:text-slate-500">Applied {formatDateTime(data.applied_at)}{data.applied_by ? ` by ${data.applied_by}` : ''}</span>
      )}
      <span className="ml-auto text-gray-400">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
    </button>
  );

  if (!data.enabled && !setup) {
    return (
      <div className="card p-4 space-y-2">
        {header}
        {open && <>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Group interfaces into zones (LAN, WAN, DMZ…) and choose what each zone can reach: the other zones and the router itself.
            MTM writes the whole filter table from that, and keeps it that way.
          </p>
          {message && <p className="text-xs text-green-600 dark:text-green-400">{message}</p>}
          {data.eligible ? (
            canWrite && <button className="btn-secondary text-xs py-1.5" onClick={() => { setSetup(true); setMessage(''); }}>Set up zones</button>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              This device has {data.foreign_rules} filter rule{data.foreign_rules === 1 ? '' : 's'} that {data.foreign_rules === 1 ? "isn't" : "aren't"} MikroTik&rsquo;s
              defaults. Zones replace the whole filter table, so they can only start from an empty table or the defaults.
            </p>
          )}
        </>}
      </div>
    );
  }

  const d = current!;
  const update = (next: ZoneRequest) => { setDraft(next); setMessage(''); };
  const labels = {
    forward: Object.fromEntries(data.services.forward.map((s) => [s.key, s.label])),
    router: Object.fromEntries(data.services.router.map((s) => [s.key, s.label])),
  };

  return (
    <div className="card p-4 space-y-4">
      {header}
      {open && <>
        {data.drift && !dirty && (
          <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-800 dark:text-amber-300 space-y-1">
            <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="w-3.5 h-3.5" /> The firewall has changed since the zones were applied</div>
            {data.drift.extra.length > 0 && <div>Not from the zones: {data.drift.extra.join('; ')}</div>}
            {data.drift.missing.length > 0 && <div>Missing or changed: {data.drift.missing.join('; ')}</div>}
            <div>Apply puts the rules back. To keep the hand edits, turn zones off.</div>
          </div>
        )}

        <ZoneList data={data} draft={d} errors={errors} editable={editing} onChange={update} />
        <Matrix draft={d} labels={labels} errors={errors} editable={editing} onChange={update} services={data.services} managerIp={data.manager_ip} />

        <div className="flex flex-wrap gap-4 text-xs text-gray-600 dark:text-slate-300">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" disabled={!editing} checked={d.config.fasttrack} onChange={(e) => update({ ...d, config: { ...d.config, fasttrack: e.target.checked } })} />
            FastTrack established connections
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" disabled={!editing} checked={d.config.logDrops} onChange={(e) => update({ ...d, config: { ...d.config, logDrops: e.target.checked } })} />
            Log what&rsquo;s dropped (shows on Firewall Events)
          </label>
          {data.manager_ip && (
            <label className="flex items-center gap-1.5">
              The manager ({data.manager_ip}) can reach
              <select className="input text-xs py-0.5 w-auto" disabled={!editing} value={d.config.managerAccess ?? 'all'}
                onChange={(e) => {
                  const { managerAccess: _drop, ...rest } = d.config;
                  void _drop;
                  update({ ...d, config: e.target.value === 'management' ? { ...rest, managerAccess: 'management' } : rest });
                }}>
                <option value="all">everything on the router</option>
                <option value="management">only the API, API-SSL and SSH ports</option>
              </select>
            </label>
          )}
        </div>

        {editing && (dirty || setup || data.drift) && (
          <div className="space-y-2">
            {errors.eligibility && <p className="text-xs text-red-600 dark:text-red-400">{errors.eligibility}</p>}
            {errors.zones && <p className="text-xs text-red-600 dark:text-red-400">{errors.zones}</p>}
            {errors.members && <p className="text-xs text-red-600 dark:text-red-400">{errors.members}</p>}
            {clean && plan.data?.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{w}</p>
            ))}
            {clean && plan.data?.changes && <PlanSummary plan={plan.data} fetching={plan.isFetching} />}
          </div>
        )}

        {message && <p className="text-xs text-green-600 dark:text-green-400">{message}</p>}
        {failure && <p className="text-xs text-red-600 dark:text-red-400">{failure}</p>}
        <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={applyMut.isPending} />

        {editing && (
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-primary text-xs py-1.5" onClick={apply}
              disabled={applyMut.isPending || !clean || Object.keys(errors).length > 0 || (!dirty && !setup && !data.drift)}>
              {applyMut.isPending ? 'Applying…' : setup ? 'Turn on zones' : 'Apply'}
            </button>
            <ReviewChangesButton className="text-xs py-1.5" deviceName={deviceName} applyLabel={setup ? 'Turn on zones' : 'Apply'} onApply={apply}
              disabled={applyMut.isPending || !clean} request={() => zonesApi.apply(deviceId, d)} />
            {(dirty || setup) && <button className="btn-secondary text-xs py-1.5" onClick={() => { setDraft(null); setSetup(false); }}>Cancel</button>}
            {data.enabled && (
              <button className="ml-auto text-xs text-gray-500 hover:text-red-600 flex items-center gap-1" disabled={offMut.isPending}
                onClick={() => { if (confirm('Turn zones off? The rules stay on the device as ordinary rules you can edit; nothing is changed.')) offMut.mutate(); }}>
                <Power className="w-3.5 h-3.5" /> Turn zones off
              </button>
            )}
          </div>
        )}
      </>}
    </div>
  );
}

function ZoneList({ data, draft, errors, editable, onChange }: {
  data: ZonesData; draft: ZoneRequest; errors: Record<string, string>; editable: boolean; onChange: (d: ZoneRequest) => void;
}) {
  const [name, setName] = useState('');
  const owner = new Map(Object.entries(draft.members).flatMap(([z, is]) => is.map((i) => [i, z] as [string, string])));
  const unused = data.lists.map((l) => l.name).filter((l) => !draft.config.zones.includes(l));
  const nameErr = name ? zoneNameError(name, draft.config.zones) : null;
  const add = (n: string) => {
    const existing = data.lists.find((l) => l.name === n)?.members.filter((m) => !m.dynamic).map((m) => m.interface) ?? [];
    onChange(addZone(draft, n, existing));
    setName('');
  };
  const ifaces = data.interfaces.filter((i) => i.type !== 'loopback');
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-gray-700 dark:text-slate-300">Zones and their interfaces</div>
      {draft.config.zones.map((z) => {
        const dynamic = data.lists.find((l) => l.name === z)?.members.filter((m) => m.dynamic).map((m) => m.interface) ?? [];
        const free = ifaces.filter((i) => !owner.has(i.name) && !dynamic.includes(i.name));
        // Bridge ports in a zone match nothing: switched traffic skips the
        // firewall, and routed traffic shows up on the bridge.
        const ports = (draft.members[z] ?? []).filter((i) => data.interfaces.some((x) => x.name === i && x.bridge_port));
        return (
          <div key={z} className="flex items-start gap-2 flex-wrap rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
            <span className="text-xs font-semibold text-gray-900 dark:text-white w-24 shrink-0 pt-0.5 truncate" title={z}>{z}</span>
            <div className="flex-1 flex flex-wrap items-center gap-1">
              {(draft.members[z] ?? []).map((i) => (
                <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-[11px] text-blue-700 dark:text-blue-300">
                  {i}
                  {editable && <button title={`Take ${i} out of ${z}`} onClick={() => onChange({ ...draft, members: { ...draft.members, [z]: draft.members[z].filter((x) => x !== i) } })}><X className="w-3 h-3" /></button>}
                </span>
              ))}
              {dynamic.map((i) => (
                <span key={i} title="Added by RouterOS (dynamic)" className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-[11px] text-gray-500 dark:text-slate-400">{i}</span>
              ))}
              {editable && free.length > 0 && (
                <select className="text-[11px] bg-transparent border border-dashed border-gray-300 dark:border-slate-600 rounded px-1 py-0.5 text-gray-500"
                  value="" onChange={(e) => e.target.value && onChange({ ...draft, members: { ...draft.members, [z]: [...(draft.members[z] ?? []), e.target.value] } })}>
                  <option value="">+ interface</option>
                  {free.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name}{i.addresses.length ? ` (${i.addresses.join(', ')})` : ''}{i.bridge_port ? ' (bridge port)' : ''}
                    </option>
                  ))}
                </select>
              )}
              {errors[`zone:${z}`] && <span className="text-[11px] text-red-600 dark:text-red-400">{errors[`zone:${z}`]}</span>}
              {ports.length > 0 && (
                <p className="basis-full flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>
                    {ports.join(', ')} {ports.length === 1 ? 'is a bridge port' : 'are bridge ports'}, so {z}&rsquo;s rules won&rsquo;t see traffic
                    through {ports.length === 1 ? 'it' : 'them'}: traffic between bridge ports is switched past the firewall, and routed
                    traffic shows up on the bridge. Use the bridge or a VLAN interface, or take {ports.length === 1 ? 'the port' : 'the ports'} out
                    of the bridge to route {ports.length === 1 ? 'it' : 'them'} on {ports.length === 1 ? 'its' : 'their'} own.
                  </span>
                </p>
              )}
            </div>
            {editable && (
              <button className="p-1 text-gray-400 hover:text-red-500" title={`Remove the ${z} zone. The interface list stays on the device.`} onClick={() => onChange(removeZone(draft, z))}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        );
      })}
      {editable && (
        <div className="flex items-center gap-2 flex-wrap">
          {unused.map((l) => (
            <button key={l} className="btn-secondary text-[11px] py-1" onClick={() => add(l)}><Plus className="w-3 h-3 inline" /> {l}</button>
          ))}
          <input className="input text-xs py-1 w-40" placeholder="New zone, e.g. DMZ" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name && !nameErr) add(name.trim()); }} />
          <button className="btn-secondary text-xs py-1" disabled={!name || !!nameErr} onClick={() => add(name.trim())}>Add zone</button>
          {nameErr && <span className="text-[11px] text-red-600 dark:text-red-400">{nameErr}</span>}
        </div>
      )}
      <p className="text-[11px] text-gray-400 dark:text-slate-500">
        A zone is an interface list on the device; a new zone creates one. Put routed interfaces in zones (a bridge, a VLAN interface, the WAN port), not the bridge&rsquo;s ports.
      </p>
    </div>
  );
}

function Matrix({ draft, labels, errors, editable, onChange, services, managerIp }: {
  draft: ZoneRequest; labels: { forward: Record<string, string>; router: Record<string, string> };
  errors: Record<string, string>; editable: boolean; onChange: (d: ZoneRequest) => void; services: ZonesData['services'];
  managerIp: string | null;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const zones = draft.config.zones;
  if (!zones.length) return null;
  const cols = [...zones, ROUTER];
  const pickedFrom = picked?.split('>')[0];
  const pickedTo = picked?.split('>')[1];
  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs font-medium text-gray-700 dark:text-slate-300">What each zone can reach</div>
        <div className="text-[11px] text-gray-500 dark:text-slate-400">
          {editable ? 'Click a cell to choose what the zone on the left can reach in the zone or router above it.' : 'Click a cell to see what\u2019s allowed.'}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="px-2 py-1.5 text-left text-gray-400 font-normal">From ↓ To →</th>
              {cols.map((c) => <th key={c} className="px-2 py-1.5 text-left font-semibold text-gray-700 dark:text-slate-200">{c === ROUTER ? 'Router' : c}</th>)}
            </tr>
          </thead>
          <tbody>
            {zones.map((from) => (
              <tr key={from}>
                <td className="px-2 py-1 font-semibold text-gray-700 dark:text-slate-200">{from}</td>
                {cols.map((to) => {
                  if (to === from) {
                    const on = draft.config.intra[from] !== false;
                    return (
                      <td key={to} className="px-1 py-1">
                        <button disabled={!editable} title="Traffic between interfaces of the same zone"
                          onClick={() => onChange({ ...draft, config: { ...draft.config, intra: { ...draft.config.intra, [from]: !on } } })}
                          className={clsx('w-28 px-2 py-1 rounded border text-left italic', on
                            ? 'border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
                            : 'border-gray-200 dark:border-slate-700 text-gray-400')}>
                          {on ? 'Within: allow' : 'Within: deny'}
                        </button>
                      </td>
                    );
                  }
                  const key = pairKey(from, to);
                  const p = draft.config.policies[key];
                  const text = policySummary(p, to === ROUTER ? labels.router : labels.forward);
                  return (
                    <td key={to} className="px-1 py-1">
                      <button onClick={() => setPicked(picked === key ? null : key)} aria-label={`${from} to ${to === ROUTER ? 'router' : to}: ${text}. Click to change.`}
                        className={clsx('group w-28 px-2 py-1 rounded border text-left cursor-pointer hover:border-blue-400 hover:shadow-sm flex items-center gap-1',
                          picked === key && 'ring-2 ring-blue-500',
                          errors[`pair:${key}`] ? 'border-red-400 text-red-600'
                            : !p ? 'border-gray-200 dark:border-slate-700 text-gray-400'
                              : p.action === 'allow' ? 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                                : 'border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300')}
                        title={text}>
                        <span className="truncate flex-1">{text}</span>
                        {editable && <Pencil className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60" />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {picked && pickedFrom && pickedTo && zones.includes(pickedFrom) && (pickedTo === ROUTER || zones.includes(pickedTo)) && (
        <PolicyEditor key={picked} from={pickedFrom} to={pickedTo} policy={draft.config.policies[picked]} editable={editable}
          options={pickedTo === ROUTER ? services.router : services.forward} error={errors[`pair:${picked}`]}
          onChange={(p) => onChange(setPolicy(draft, picked, p))} onClose={() => setPicked(null)} />
      )}
      <p className="text-[11px] text-gray-400 dark:text-slate-500">
        Replies to allowed connections always get back. Anything not allowed here is dropped.
        {managerIp && (draft.config.managerAccess === 'management'
          ? <> The manager ({managerIp}) can always reach the router&rsquo;s API, API-SSL and SSH ports.</>
          : <> The manager ({managerIp}) can always reach the router.</>)}
      </p>
    </div>
  );
}

function PolicyEditor({ from, to, policy, options, editable, error, onChange, onClose }: {
  from: string; to: string; policy?: ZonePolicy; options: { key: string; label: string }[]; editable: boolean; error?: string;
  onChange: (p: ZonePolicy) => void; onClose: () => void;
}) {
  const p: ZonePolicy = policy ?? { action: 'deny', services: [], custom: [] };
  const target = to === ROUTER ? 'the router' : to;
  const set = (next: Partial<ZonePolicy>) => onChange({ ...p, ...next });
  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-900/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-800 dark:text-slate-100">{from} → {to === ROUTER ? 'Router' : to}</span>
        <button className="ml-auto text-gray-400 hover:text-gray-600" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-gray-700 dark:text-slate-300">
        {([['deny', 'Deny'], ['allow', `Allow everything to ${target}`], ['services', 'Only these services']] as const).map(([a, label]) => (
          <label key={a} className="flex items-center gap-1.5">
            <input type="radio" disabled={!editable} checked={p.action === a}
              onChange={() => set(a === 'services' ? { action: a, services: p.services.length ? p.services : ['ping'] } : { action: a })} />
            {label}
          </label>
        ))}
      </div>
      {p.action === 'services' && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => {
              const on = p.services.includes(o.key);
              return (
                <button key={o.key} disabled={!editable}
                  onClick={() => set({ services: on ? p.services.filter((s) => s !== o.key) : [...p.services, o.key] })}
                  className={clsx('px-2 py-0.5 rounded-full border text-[11px]', on
                    ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300')}>
                  {o.label}
                </button>
              );
            })}
          </div>
          <div className="space-y-1">
            {p.custom.map((c, i) => {
              const bad = customError(c);
              const edit = (patch: Partial<typeof c>) => set({ custom: p.custom.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select className="input text-xs py-1 w-24" disabled={!editable} value={c.protocol} aria-label="Protocol"
                      onChange={(e) => {
                        const protocol = e.target.value as typeof c.protocol;
                        // Only TCP and UDP have ports; each other choice keeps its own field.
                        edit(protocol === 'tcp' || protocol === 'udp' ? { protocol } : { protocol, ports: '' });
                      }}>
                      <option value="tcp">TCP</option><option value="udp">UDP</option><option value="icmp">ICMP</option>
                      <option value="other">Protocol #</option><option value="any">Any</option>
                    </select>
                    {c.protocol === 'icmp' ? (
                      <input className="input text-xs py-1 w-32 font-mono" disabled={!editable} value={c.icmp ?? ''}
                        placeholder="any type, or 8, 3:4" aria-label="ICMP type" title="ICMP type, or type:code. Empty allows every type."
                        onChange={(e) => edit({ icmp: e.target.value })} />
                    ) : c.protocol === 'other' ? (
                      <span className="flex items-center gap-1">
                        <input className="input text-xs py-1 w-16 font-mono" disabled={!editable} value={c.number ?? ''}
                          placeholder="89" aria-label="IP protocol number" inputMode="numeric"
                          onChange={(e) => edit({ number: e.target.value })} />
                        {protocolName(c.number ?? '') && <span className="text-[11px] text-gray-500 dark:text-slate-400">{protocolName(c.number ?? '')}</span>}
                      </span>
                    ) : (
                      <input className="input text-xs py-1 w-32 font-mono" disabled={!editable || c.protocol === 'any'} value={c.ports}
                        placeholder={c.protocol === 'any' ? 'all ports' : '8080 or 5000-5010'} aria-label="Ports"
                        onChange={(e) => edit({ ports: e.target.value })} />
                    )}
                    <span className="text-[11px] text-gray-500 dark:text-slate-400">from</span>
                    <input className="input text-xs py-1 w-36 font-mono" disabled={!editable} value={c.src ?? ''}
                      title="An address, a subnet, a range, or a hostname such as smtp.office365.com"
                      placeholder="anywhere" aria-label="Source address" onChange={(e) => edit({ src: e.target.value })} />
                    <span className="text-[11px] text-gray-500 dark:text-slate-400">to</span>
                    <input className="input text-xs py-1 w-36 font-mono" disabled={!editable} value={c.dst ?? ''}
                      title="An address, a subnet, a range, or a hostname such as smtp.office365.com"
                      placeholder="anywhere" aria-label="Destination address" onChange={(e) => edit({ dst: e.target.value })} />
                    {editable && <button className="text-gray-400 hover:text-red-500" aria-label="Remove this rule" onClick={() => set({ custom: p.custom.filter((_, j) => j !== i) })}><X className="w-3.5 h-3.5" /></button>}
                  </div>
                  {bad && <p className="text-[11px] text-red-600 dark:text-red-400">{bad}</p>}
                </div>
              );
            })}
            {editable && p.custom.length < 10 && (
              <button className="text-[11px] text-blue-600 hover:underline" onClick={() => set({ custom: [...p.custom, { protocol: 'tcp', ports: '' }] })}>+ Custom rule (ports, protocols, addresses)</button>
            )}
          </div>
        </>
      )}
      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function PlanSummary({ plan, fetching }: { plan: ZonePlan; fetching: boolean }) {
  const [show, setShow] = useState(false);
  const c = plan.changes!;
  const parts = [
    ...(c.lists.length ? [`create the list${c.lists.length === 1 ? '' : 's'} ${c.lists.join(', ')}`] : []),
    ...c.members_added.map((m) => `add ${m.interface} to ${m.list}`),
    ...c.members_removed.map((m) => `take ${m.interface} out of ${m.list}`),
    ...(c.host_lists_added ?? []).map((l) => `create the address list ${l}`),
    ...(c.host_lists_removed ?? []).map((l) => `remove the address list ${l}`),
    `add ${c.add} rule${c.add === 1 ? '' : 's'}`, `remove ${c.remove}`, `keep ${c.keep}`,
  ];
  return (
    <div className={clsx('text-xs text-gray-600 dark:text-slate-300 space-y-1', fetching && 'opacity-60')}>
      <div>Applying will {parts.join(', ')}.{' '}
        <button className="text-blue-600 hover:underline" onClick={() => setShow(!show)}>{show ? 'Hide the rules' : `Show the ${plan.rules.length} rules`}</button>
      </div>
      {show && (
        <ol className="font-mono text-[11px] space-y-0.5 pl-5 list-decimal">
          {plan.rules.map((r, i) => (
            <li key={i} className={clsx(r.hidden && 'text-gray-400 dark:text-slate-500')}>
              <span className="text-gray-400">{r.chain}</span> {r.action}{r['jump-target'] ? ` → ${r['jump-target']}` : ''} · {r.description}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
