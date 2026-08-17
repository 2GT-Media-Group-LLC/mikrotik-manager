import { useState } from 'react';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, AlertCircle, RefreshCw } from 'lucide-react';
import { devicesApi } from '../../services/api';
import clsx from 'clsx';
import { useCanWrite } from '../../hooks/useCanWrite';

// ─── Extended devicesApi type (routing protocol methods added at runtime) ──────
const dApi = devicesApi as typeof devicesApi & {
  getOspf: (id: number) => Promise<{ data: Record<string, unknown> }>;
  getBgp: (id: number) => Promise<{ data: Record<string, unknown> }>;
  getRoutingTables: (id: number) => Promise<{ data: Record<string, string>[] }>;
  getRouteFilters: (id: number) => Promise<{ data: Record<string, unknown> }>;
  getRouterIds: (id: number) => Promise<{ data: Record<string, string>[] }>;
  addOspfInstance: (id: number, d: Record<string, unknown>) => Promise<unknown>;
  removeOspfInstance: (id: number, itemId: string) => Promise<unknown>;
  addOspfArea: (id: number, d: Record<string, unknown>) => Promise<unknown>;
  removeOspfArea: (id: number, itemId: string) => Promise<unknown>;
  addBgpConnection: (id: number, d: Record<string, unknown>) => Promise<unknown>;
  removeBgpConnection: (id: number, itemId: string) => Promise<unknown>;
  addRoutingTable: (id: number, d: { name: string; fib?: boolean }) => Promise<unknown>;
  removeRoutingTable: (id: number, itemId: string) => Promise<unknown>;
  addFilterRule: (id: number, d: Record<string, unknown>) => Promise<unknown>;
  removeFilterRule: (id: number, itemId: string) => Promise<unknown>;
};

const SUB_TABS = ['Routes', 'OSPF', 'BGP', 'Route Filters', 'Tables'] as const;
type SubTab = (typeof SUB_TABS)[number];

// ─── Reusable helpers ─────────────────────────────────────────────────────────
function errMsg(err: unknown) {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Operation failed';
}

function KVTable({ rows }: { rows: Record<string, string>[] }) {
  if (!rows.length) return <Empty text="No entries." />;
  const keys = Object.keys(rows[0]).filter(k => k !== '.id');
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
            {keys.map(k => (
              <th key={k} className="table-header px-4 py-2.5 text-left">{k}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
              {keys.map(k => (
                <td key={k} className="px-4 py-2.5 font-mono text-xs text-gray-700 dark:text-slate-300">
                  {String(r[k] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-center py-8 text-gray-400 dark:text-slate-500">{text}</p>;
}

function SectionHeader({ title, onRefresh, isFetching }: { title: string; onRefresh: () => void; isFetching: boolean }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      <button onClick={onRefresh} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5">
        <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
      </button>
    </div>
  );
}

// ─── Routes sub-tab (original) ────────────────────────────────────────────────
function RoutesSubTab({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const { data: routes = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['routing', deviceId],
    queryFn: () => devicesApi.getRouting(deviceId).then(r => r.data),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ dst_address: '', gateway: '', distance: '1', comment: '' });
  const [addError, setAddError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  // 409 + verdict from the lockout predictor, with the retry that confirms it.
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);

  const addMutation = useMutation({
    mutationFn: (confirm: boolean) => devicesApi.addRoute(deviceId, {
      dst_address: form.dst_address,
      gateway: form.gateway,
      distance: form.distance ? parseInt(form.distance, 10) : undefined,
      comment: form.comment || undefined,
      ...(confirm ? { confirm_lockout: true } : {}),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing', deviceId] });
      setForm({ dst_address: '', gateway: '', distance: '1', comment: '' });
      setShowAdd(false);
      setAddError('');
      setLockout(null);
    },
    onError: (err: unknown) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => addMutation.mutate(true) }); return; }
      setAddError(errMsg(err));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ routeId, confirm = false }: { routeId: string; confirm?: boolean }) =>
      devicesApi.deleteRoute(deviceId, routeId, confirm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing', deviceId] });
      setDeleteError('');
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => deleteMutation.mutate({ routeId: vars.routeId, confirm: true }) });
        return;
      }
      setDeleteError(errMsg(err));
    },
  });

  const isDynamic = (r: Record<string, string>) =>
    r['dynamic'] === 'true' || (r['flags'] && /[DCBOE]/.test(r['flags']));

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          {deleteError && (
            <span className="text-sm text-red-500 flex items-center gap-1">
              <AlertCircle className="w-4 h-4" />{deleteError}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-2 text-sm">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
          {canWrite && (
            <button onClick={() => { setShowAdd(!showAdd); setAddError(''); }} className="btn-primary flex items-center gap-2 text-sm">
              <Plus className="w-4 h-4" /> Add Route
            </button>
          )}
        </div>
      </div>

      {canWrite && showAdd && (
        <div className="card p-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">New Static Route</h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><label className="label">Destination (CIDR)</label>
              <input className="input font-mono" value={form.dst_address} onChange={e => setForm(f => ({ ...f, dst_address: e.target.value }))} placeholder="0.0.0.0/0" /></div>
            <div><label className="label">Gateway</label>
              <input className="input font-mono" value={form.gateway} onChange={e => setForm(f => ({ ...f, gateway: e.target.value }))} placeholder="192.168.1.1" /></div>
            <div><label className="label">Distance</label>
              <input type="number" className="input" value={form.distance} onChange={e => setForm(f => ({ ...f, distance: e.target.value }))} min={1} max={255} /></div>
            <div><label className="label">Comment</label>
              <input className="input" value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} placeholder="Optional" /></div>
          </div>
          {addError && <div className="flex items-center gap-2 text-sm text-red-500"><AlertCircle className="w-4 h-4" />{addError}</div>}
          <div className="flex gap-2">
            <button onClick={() => addMutation.mutate(false)} disabled={!form.dst_address || !form.gateway || addMutation.isPending} className="btn-primary flex items-center gap-2 text-sm">
              {addMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Add Route
            </button>
            <button onClick={() => setShowAdd(false)} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        {routes.length === 0 ? (
          <Empty text="No routes found." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="table-header px-4 py-2.5 text-left">Destination</th>
                <th className="table-header px-4 py-2.5 text-left">Gateway</th>
                <th className="table-header px-4 py-2.5 text-left">Interface</th>
                <th className="table-header px-4 py-2.5 text-left">Dist.</th>
                <th className="table-header px-4 py-2.5 text-left">Status</th>
                <th className="table-header px-4 py-2.5 text-left">Comment</th>
                {canWrite && <th className="table-header px-4 py-2.5 w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {(routes as Record<string, string>[]).map((r, i) => {
                const active = r['active'] === 'true' || r['flags']?.includes('A');
                const dynamic = isDynamic(r);
                const routeId = r['.id'] || '';
                return (
                  <tr key={routeId || i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-mono text-gray-900 dark:text-white">{r['dst-address'] || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-slate-400">{r['gateway'] || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-slate-400">{r['interface'] || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">{r['distance'] || '—'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className={clsx('text-xs font-medium', active ? 'text-green-600 dark:text-green-400' : 'text-gray-400')}>
                          {active ? 'Active' : 'Inactive'}
                        </span>
                        {dynamic && <span className="text-xs text-gray-400 dark:text-slate-500">(dynamic)</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 dark:text-slate-500 text-xs">{r['comment'] || ''}</td>
                    {canWrite && (
                      <td className="px-4 py-2.5">
                        {!dynamic && routeId && (
                          <button
                            onClick={() => { if (confirm(`Remove route to ${r['dst-address']}?`)) deleteMutation.mutate({ routeId }); }}
                            disabled={deleteMutation.isPending}
                            className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {lockout && (
        <LockoutVerdictDialog
          verdict={lockout.verdict}
          confirmPhrase={deviceName || 'confirm'}
          pending={addMutation.isPending || deleteMutation.isPending}
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}
    </div>
  );
}

// ─── OSPF sub-tab ─────────────────────────────────────────────────────────────
function OspfSubTab({ deviceId }: { deviceId: number }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['routing-ospf', deviceId],
    queryFn: () => dApi.getOspf(deviceId).then(r => r.data),
  });

  const [showAddInstance, setShowAddInstance] = useState(false);
  const [instanceForm, setInstanceForm] = useState({ name: '', 'router-id': '' });
  const [showAddArea, setShowAddArea] = useState(false);
  const [areaForm, setAreaForm] = useState({ name: '', area: '0.0.0.0', instance: '' });
  const [error, setError] = useState('');

  const addInstanceMutation = useMutation({
    mutationFn: () => dApi.addOspfInstance(deviceId, instanceForm),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['routing-ospf', deviceId] }); setShowAddInstance(false); setInstanceForm({ name: '', 'router-id': '' }); setError(''); },
    onError: (err: unknown) => setError(errMsg(err)),
  });

  const removeInstanceMutation = useMutation({
    mutationFn: (id: string) => dApi.removeOspfInstance(deviceId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routing-ospf', deviceId] }),
    onError: (err: unknown) => setError(errMsg(err)),
  });

  const addAreaMutation = useMutation({
    mutationFn: () => dApi.addOspfArea(deviceId, areaForm),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['routing-ospf', deviceId] }); setShowAddArea(false); setAreaForm({ name: '', area: '0.0.0.0', instance: '' }); setError(''); },
    onError: (err: unknown) => setError(errMsg(err)),
  });

  const removeAreaMutation = useMutation({
    mutationFn: (id: string) => dApi.removeOspfArea(deviceId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routing-ospf', deviceId] }),
    onError: (err: unknown) => setError(errMsg(err)),
  });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;

  const instances = (data?.instances as Record<string, string>[]) || [];
  const areas     = (data?.areas     as Record<string, string>[]) || [];
  const interfaces= (data?.interfaces as Record<string, string>[]) || [];
  const neighbors = (data?.neighbors  as Record<string, string>[]) || [];

  return (
    <div className="space-y-6">
      {error && <div className="flex items-center gap-2 text-sm text-red-500"><AlertCircle className="w-4 h-4" />{error}</div>}

      {/* Instances */}
      <div>
        <SectionHeader title="Instances" onRefresh={refetch} isFetching={isFetching} />
        {canWrite && (
          <div className="mb-3">
            {showAddInstance ? (
              <div className="card p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">Name</label><input className="input" value={instanceForm.name} onChange={e => setInstanceForm(f => ({ ...f, name: e.target.value }))} placeholder="default" /></div>
                  <div><label className="label">Router ID</label><input className="input font-mono" value={instanceForm['router-id']} onChange={e => setInstanceForm(f => ({ ...f, 'router-id': e.target.value }))} placeholder="1.2.3.4" /></div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => addInstanceMutation.mutate()} disabled={!instanceForm.name || addInstanceMutation.isPending} className="btn-primary text-sm flex items-center gap-1.5">
                    {addInstanceMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Add
                  </button>
                  <button onClick={() => setShowAddInstance(false)} className="btn-secondary text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowAddInstance(true)} className="btn-secondary flex items-center gap-1.5 text-sm"><Plus className="w-3.5 h-3.5" /> Add Instance</button>
            )}
          </div>
        )}
        {instances.length === 0 ? <Empty text="No OSPF instances." /> : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="table-header px-4 py-2.5 text-left">Name</th>
                <th className="table-header px-4 py-2.5 text-left">Router ID</th>
                <th className="table-header px-4 py-2.5 text-left">State</th>
                {canWrite && <th className="w-10" />}
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {instances.map((inst, i) => (
                  <tr key={inst['.id'] || i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{inst['name'] || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-slate-400">{inst['router-id'] || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">{inst['state'] || inst['status'] || '—'}</td>
                    {canWrite && <td className="px-4 py-2.5">
                      {inst['.id'] && <button onClick={() => { if (confirm('Remove instance?')) removeInstanceMutation.mutate(inst['.id']); }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Areas */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Areas</h3>
        {canWrite && (
          <div className="mb-3">
            {showAddArea ? (
              <div className="card p-4 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div><label className="label">Name</label><input className="input" value={areaForm.name} onChange={e => setAreaForm(f => ({ ...f, name: e.target.value }))} placeholder="backbone" /></div>
                  <div><label className="label">Area ID</label><input className="input font-mono" value={areaForm.area} onChange={e => setAreaForm(f => ({ ...f, area: e.target.value }))} placeholder="0.0.0.0" /></div>
                  <div><label className="label">Instance</label><input className="input" value={areaForm.instance} onChange={e => setAreaForm(f => ({ ...f, instance: e.target.value }))} placeholder="default" /></div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => addAreaMutation.mutate()} disabled={!areaForm.name || addAreaMutation.isPending} className="btn-primary text-sm flex items-center gap-1.5">
                    {addAreaMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Add
                  </button>
                  <button onClick={() => setShowAddArea(false)} className="btn-secondary text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowAddArea(true)} className="btn-secondary flex items-center gap-1.5 text-sm"><Plus className="w-3.5 h-3.5" /> Add Area</button>
            )}
          </div>
        )}
        {areas.length === 0 ? <Empty text="No OSPF areas." /> : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="table-header px-4 py-2.5 text-left">Name</th>
                <th className="table-header px-4 py-2.5 text-left">Area</th>
                <th className="table-header px-4 py-2.5 text-left">Instance</th>
                {canWrite && <th className="w-10" />}
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {areas.map((a, i) => (
                  <tr key={a['.id'] || i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{a['name'] || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-slate-400">{a['area'] || a['area-id'] || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">{a['instance'] || '—'}</td>
                    {canWrite && <td className="px-4 py-2.5">
                      {a['.id'] && <button onClick={() => { if (confirm('Remove area?')) removeAreaMutation.mutate(a['.id']); }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Interfaces (read-only) */}
      {interfaces.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Interfaces</h3>
          <KVTable rows={interfaces} />
        </div>
      )}

      {/* Neighbors (read-only) */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Neighbors</h3>
        {neighbors.length === 0 ? <Empty text="No OSPF neighbors." /> : <KVTable rows={neighbors} />}
      </div>
    </div>
  );
}

// ─── BGP sub-tab ──────────────────────────────────────────────────────────────
function BgpSubTab({ deviceId }: { deviceId: number }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['routing-bgp', deviceId],
    queryFn: () => dApi.getBgp(deviceId).then(r => r.data),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', 'remote.address': '', 'remote.as': '', 'local.role': 'ebgp' });
  const [error, setError] = useState('');

  const addMutation = useMutation({
    mutationFn: () => dApi.addBgpConnection(deviceId, form),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['routing-bgp', deviceId] }); setShowAdd(false); setForm({ name: '', 'remote.address': '', 'remote.as': '', 'local.role': 'ebgp' }); setError(''); },
    onError: (err: unknown) => setError(errMsg(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => dApi.removeBgpConnection(deviceId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routing-bgp', deviceId] }),
    onError: (err: unknown) => setError(errMsg(err)),
  });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;

  const connections = (data?.connections as Record<string, string>[]) || [];
  const sessions    = (data?.sessions    as Record<string, string>[]) || [];

  return (
    <div className="space-y-6">
      {error && <div className="flex items-center gap-2 text-sm text-red-500"><AlertCircle className="w-4 h-4" />{error}</div>}

      {/* Connections */}
      <div>
        <SectionHeader title="BGP Connections" onRefresh={refetch} isFetching={isFetching} />
        {canWrite && (
          <div className="mb-3">
            {showAdd ? (
              <div className="card p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div><label className="label">Name</label><input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="peer-name" /></div>
                  <div><label className="label">Remote Address</label><input className="input font-mono" value={form['remote.address']} onChange={e => setForm(f => ({ ...f, 'remote.address': e.target.value }))} placeholder="10.0.0.1" /></div>
                  <div><label className="label">Remote AS</label><input className="input font-mono" value={form['remote.as']} onChange={e => setForm(f => ({ ...f, 'remote.as': e.target.value }))} placeholder="65000" /></div>
                  <div><label className="label">Role</label>
                    <select className="input" value={form['local.role']} onChange={e => setForm(f => ({ ...f, 'local.role': e.target.value }))}>
                      <option value="ebgp">eBGP</option>
                      <option value="ibgp">iBGP</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => addMutation.mutate()} disabled={!form.name || !form['remote.address'] || addMutation.isPending} className="btn-primary text-sm flex items-center gap-1.5">
                    {addMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Add
                  </button>
                  <button onClick={() => setShowAdd(false)} className="btn-secondary text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowAdd(true)} className="btn-secondary flex items-center gap-1.5 text-sm"><Plus className="w-3.5 h-3.5" /> Add Connection</button>
            )}
          </div>
        )}
        {connections.length === 0 ? <Empty text="No BGP connections configured." /> : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="table-header px-4 py-2.5 text-left">Name</th>
                <th className="table-header px-4 py-2.5 text-left">Remote Address</th>
                <th className="table-header px-4 py-2.5 text-left">Remote AS</th>
                <th className="table-header px-4 py-2.5 text-left">Role</th>
                {canWrite && <th className="w-10" />}
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {connections.map((c, i) => (
                  <tr key={c['.id'] || i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{c['name'] || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-slate-400">{c['remote.address'] || c['remote-address'] || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-slate-400">{c['remote.as'] || c['remote-as'] || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">{c['local.role'] || c['local-role'] || '—'}</td>
                    {canWrite && <td className="px-4 py-2.5">
                      {c['.id'] && <button onClick={() => { if (confirm('Remove BGP connection?')) removeMutation.mutate(c['.id']); }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sessions (read-only) */}
      {sessions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Active Sessions</h3>
          <KVTable rows={sessions} />
        </div>
      )}
    </div>
  );
}

// ─── Route Filters sub-tab ────────────────────────────────────────────────────
function RouteFiltersSubTab({ deviceId }: { deviceId: number }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['routing-filters', deviceId],
    queryFn: () => dApi.getRouteFilters(deviceId).then(r => r.data),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ chain: '', action: 'accept', prefix: '', comment: '' });
  const [error, setError] = useState('');

  const addMutation = useMutation({
    mutationFn: () => dApi.addFilterRule(deviceId, { ...form, prefix: form.prefix || undefined }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['routing-filters', deviceId] }); setShowAdd(false); setForm({ chain: '', action: 'accept', prefix: '', comment: '' }); setError(''); },
    onError: (err: unknown) => setError(errMsg(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => dApi.removeFilterRule(deviceId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routing-filters', deviceId] }),
    onError: (err: unknown) => setError(errMsg(err)),
  });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;

  const rules = (data?.rules as Record<string, string>[]) || [];

  return (
    <div className="space-y-4">
      {error && <div className="flex items-center gap-2 text-sm text-red-500"><AlertCircle className="w-4 h-4" />{error}</div>}
      <SectionHeader title="Route Filter Rules" onRefresh={refetch} isFetching={isFetching} />

      {canWrite && (
        <div className="mb-3">
          {showAdd ? (
            <div className="card p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><label className="label">Chain</label><input className="input" value={form.chain} onChange={e => setForm(f => ({ ...f, chain: e.target.value }))} placeholder="my-filter" /></div>
                <div><label className="label">Action</label>
                  <select className="input" value={form.action} onChange={e => setForm(f => ({ ...f, action: e.target.value }))}>
                    <option value="accept">accept</option>
                    <option value="reject">reject</option>
                    <option value="discard">discard</option>
                    <option value="return">return</option>
                  </select>
                </div>
                <div><label className="label">Prefix (optional)</label><input className="input font-mono" value={form.prefix} onChange={e => setForm(f => ({ ...f, prefix: e.target.value }))} placeholder="10.0.0.0/8" /></div>
                <div><label className="label">Comment</label><input className="input" value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} placeholder="Optional" /></div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => addMutation.mutate()} disabled={!form.chain || addMutation.isPending} className="btn-primary text-sm flex items-center gap-1.5">
                  {addMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Add Rule
                </button>
                <button onClick={() => setShowAdd(false)} className="btn-secondary text-sm">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAdd(true)} className="btn-secondary flex items-center gap-1.5 text-sm"><Plus className="w-3.5 h-3.5" /> Add Rule</button>
          )}
        </div>
      )}

      {rules.length === 0 ? <Empty text="No route filter rules." /> : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
              <th className="table-header px-4 py-2.5 text-left">#</th>
              <th className="table-header px-4 py-2.5 text-left">Chain</th>
              <th className="table-header px-4 py-2.5 text-left">Action</th>
              <th className="table-header px-4 py-2.5 text-left">Prefix</th>
              <th className="table-header px-4 py-2.5 text-left">Comment</th>
              {canWrite && <th className="w-10" />}
            </tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {rules.map((r, i) => (
                <tr key={r['.id'] || i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2.5 text-gray-400 dark:text-slate-500 text-xs">{i + 1}</td>
                  <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{r['chain'] || '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className={clsx('text-xs font-medium', r['action'] === 'accept' ? 'text-green-600 dark:text-green-400' : 'text-red-500')}>
                      {r['action'] || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">{r['prefix'] || r['dst-address'] || '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500">{r['comment'] || ''}</td>
                  {canWrite && <td className="px-4 py-2.5">
                    {r['.id'] && <button onClick={() => { if (confirm('Remove filter rule?')) removeMutation.mutate(r['.id']); }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Routing Tables sub-tab ───────────────────────────────────────────────────
function TablesSubTab({ deviceId }: { deviceId: number }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const { data: tables = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['routing-tables', deviceId],
    queryFn: () => dApi.getRoutingTables(deviceId).then(r => r.data),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', fib: false });
  const [error, setError] = useState('');

  const addMutation = useMutation({
    mutationFn: () => dApi.addRoutingTable(deviceId, form),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['routing-tables', deviceId] }); setShowAdd(false); setForm({ name: '', fib: false }); setError(''); },
    onError: (err: unknown) => setError(errMsg(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => dApi.removeRoutingTable(deviceId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routing-tables', deviceId] }),
    onError: (err: unknown) => setError(errMsg(err)),
  });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      {error && <div className="flex items-center gap-2 text-sm text-red-500"><AlertCircle className="w-4 h-4" />{error}</div>}
      <SectionHeader title="Routing Tables" onRefresh={refetch} isFetching={isFetching} />

      {canWrite && (
        <div className="mb-3">
          {showAdd ? (
            <div className="card p-4 space-y-3">
              <div className="flex items-end gap-3">
                <div className="flex-1"><label className="label">Table Name</label><input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="my-table" /></div>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 mb-1 cursor-pointer">
                  <input type="checkbox" checked={form.fib} onChange={e => setForm(f => ({ ...f, fib: e.target.checked }))} className="rounded" />
                  FIB
                </label>
              </div>
              <div className="flex gap-2">
                <button onClick={() => addMutation.mutate()} disabled={!form.name || addMutation.isPending} className="btn-primary text-sm flex items-center gap-1.5">
                  {addMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Add Table
                </button>
                <button onClick={() => setShowAdd(false)} className="btn-secondary text-sm">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAdd(true)} className="btn-secondary flex items-center gap-1.5 text-sm"><Plus className="w-3.5 h-3.5" /> Add Table</button>
          )}
        </div>
      )}

      {tables.length === 0 ? <Empty text="No custom routing tables." /> : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
              <th className="table-header px-4 py-2.5 text-left">Name</th>
              <th className="table-header px-4 py-2.5 text-left">FIB</th>
              {canWrite && <th className="w-10" />}
            </tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {tables.map((t, i) => (
                <tr key={t['.id'] || i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{t['name'] || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">{t['fib'] === 'true' ? 'Yes' : 'No'}</td>
                  {canWrite && <td className="px-4 py-2.5">
                    {t['.id'] && <button onClick={() => { if (confirm(`Remove table "${t['name']}"?`)) removeMutation.mutate(t['.id']); }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main RoutingTab with sub-tabs ────────────────────────────────────────────
export default function RoutingTab({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('Routes');

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-slate-700">
        {SUB_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveSubTab(tab)}
            className={clsx(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
              activeSubTab === tab
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {activeSubTab === 'Routes'        && <RoutesSubTab deviceId={deviceId} deviceName={deviceName} />}
      {activeSubTab === 'OSPF'          && <OspfSubTab deviceId={deviceId} />}
      {activeSubTab === 'BGP'           && <BgpSubTab deviceId={deviceId} />}
      {activeSubTab === 'Route Filters' && <RouteFiltersSubTab deviceId={deviceId} />}
      {activeSubTab === 'Tables'        && <TablesSubTab deviceId={deviceId} />}
    </div>
  );
}
