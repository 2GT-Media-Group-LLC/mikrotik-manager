import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileText, RefreshCw, AlertTriangle, Plus, Pencil, Trash2, X, Save,
  CheckCircle, XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { networkServicesApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';

type NS = Record<string, string>;

interface PushResult { name: string; success: boolean; error?: string }
interface DeviceCoverage { deviceId: number; deviceName: string; rowId: string }
interface AggregatedRow { key: string; sample: NS; coverage: DeviceCoverage[] }
interface PendingOp {
  type: 'action' | 'rule';
  operation: 'add' | 'update';
  data: NS;
  coverage?: DeviceCoverage[]; // only set for updates
}

const BUILTIN_ACTION_NAMES = ['memory', 'disk', 'echo', 'remote'];

const SYSLOG_FACILITIES = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'local0', 'local1', 'local2', 'local3', 'local4',
  'local5', 'local6', 'local7',
];

const SYSLOG_SEVERITIES = [
  'auto', 'debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency',
];

const ACTION_TYPES = ['remote', 'memory', 'disk', 'echo'];

const COMMON_TOPICS = 'account, caps, bridge, ddns, dhcp, dns, error, firewall, hotspot, info, interface, ipsec, ntp, ospf, ppp, radius, rip, route, script, snmp, system, warning, wireless';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function aggregateActions(
  deviceData: { deviceId: number; deviceName: string; actions: NS[] }[]
): AggregatedRow[] {
  const map = new Map<string, AggregatedRow>();
  for (const d of deviceData) {
    const seenKeys = new Set<string>();
    for (const a of d.actions) {
      const key = a['name'] ?? '';
      if (!map.has(key)) map.set(key, { key, sample: a, coverage: [] });
      if (!seenKeys.has(key)) {
        map.get(key)!.coverage.push({ deviceId: d.deviceId, deviceName: d.deviceName, rowId: a['.id'] ?? '' });
        seenKeys.add(key);
      }
    }
  }
  return Array.from(map.values());
}

function aggregateRules(
  deviceData: { deviceId: number; deviceName: string; rules: NS[] }[]
): AggregatedRow[] {
  const map = new Map<string, AggregatedRow>();
  for (const d of deviceData) {
    const seenKeys = new Set<string>();
    for (const r of d.rules) {
      const key = `${r['topics'] ?? ''}|${r['action'] ?? ''}`;
      if (!map.has(key)) map.set(key, { key, sample: r, coverage: [] });
      if (!seenKeys.has(key)) {
        map.get(key)!.coverage.push({ deviceId: d.deviceId, deviceName: d.deviceName, rowId: r['.id'] ?? '' });
        seenKeys.add(key);
      }
    }
  }
  return Array.from(map.values());
}

// ─── Coverage badge ───────────────────────────────────────────────────────────

function CoverageBadge({ coverage, total }: { coverage: DeviceCoverage[]; total: number }) {
  const n = coverage.length;
  const allMatch = n === total;
  return (
    <span title={coverage.map(c => c.deviceName).join(', ')}
      className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-default',
        allMatch
          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
          : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400')}>
      {n}/{total} devices
    </span>
  );
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch" aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <span className={clsx('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
    </button>
  );
}

// ─── ActionForm Modal ─────────────────────────────────────────────────────────

interface ActionFormProps {
  existing?: NS;
  allDevices?: boolean;
  targetName?: string; // single target device name (single-device add)
  onSave: (data: NS) => void;
  onClose: () => void;
  isPending: boolean;
  error?: string;
}

function ActionForm({ existing, allDevices, targetName, onSave, onClose, isPending, error }: ActionFormProps) {
  const isBuiltin = existing ? BUILTIN_ACTION_NAMES.includes(existing['name'] ?? '') : false;

  const [name, setName]         = useState(existing?.['name'] ?? '');
  const [type, setType]         = useState(existing?.['type'] ?? 'remote');
  const [remote, setRemote]     = useState(existing?.['remote'] ?? '');
  const [port, setPort]         = useState(existing?.['remote-port'] ?? '514');
  const [srcAddr, setSrcAddr]   = useState(existing?.['src-address'] ?? '');
  const [facility, setFacility] = useState(existing?.['syslog-facility'] ?? 'daemon');
  const [severity, setSeverity] = useState(existing?.['syslog-severity'] ?? 'auto');
  const [bsd, setBsd]           = useState((existing?.['bsd-syslog'] ?? 'no') === 'yes');

  const canSave = name.trim() !== '' && (type !== 'remote' || remote.trim() !== '');

  const title = existing
    ? 'Edit Logging Action'
    : targetName
      ? `Add Logging Action — ${targetName}`
      : allDevices ? 'Add Logging Action — All Devices' : 'Add Logging Action';

  function handleSubmit() {
    const data: NS = { name: name.trim(), type };
    if (srcAddr.trim()) data['src-address'] = srcAddr.trim();
    else if (existing) data['src-address'] = '';   // cleared on the device
    if (type === 'remote') {
      data['remote'] = remote.trim();
      data['remote-port'] = port || '514';
      data['syslog-facility'] = facility;
      data['syslog-severity'] = severity;
      data['bsd-syslog'] = bsd ? 'yes' : 'no';
    }
    onSave(data);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Name</label>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)}
              placeholder="remote-syslog" disabled={isBuiltin} />
            {isBuiltin && <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Built-in action names cannot be changed.</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Type</label>
            <select className="input w-full" value={type} onChange={e => setType(e.target.value)} disabled={isBuiltin}>
              {ACTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {type === 'remote' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Remote Address <span className="text-red-500">*</span></label>
                <input className="input w-full" value={remote} onChange={e => setRemote(e.target.value)}
                  placeholder="192.168.1.100 or syslog.example.com" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Remote Port</label>
                  <input type="number" className="input w-full" value={port} onChange={e => setPort(e.target.value)}
                    placeholder="514" min="1" max="65535" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Source Address</label>
                  <input className="input w-full" value={srcAddr} onChange={e => setSrcAddr(e.target.value)} placeholder="optional" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Syslog Facility</label>
                  <select className="input w-full" value={facility} onChange={e => setFacility(e.target.value)}>
                    {SYSLOG_FACILITIES.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Syslog Severity</label>
                  <select className="input w-full" value={severity} onChange={e => setSeverity(e.target.value)}>
                    {SYSLOG_SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Toggle checked={bsd} onChange={setBsd} />
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-slate-200">BSD Syslog (RFC3164)</div>
                  <p className="text-xs text-gray-400 dark:text-slate-500">Use legacy BSD format instead of RFC5424.</p>
                </div>
              </div>
            </>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t border-gray-200 dark:border-slate-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors">Cancel</button>
          <button onClick={handleSubmit} disabled={!canSave || isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
            <Save className="w-3.5 h-3.5" />{isPending ? 'Saving…' : allDevices ? 'Review & Push' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RuleForm Modal ───────────────────────────────────────────────────────────

interface RuleFormProps {
  existing?: NS;
  actions: NS[];
  allDevices?: boolean;
  targetName?: string; // single target device name (single-device add)
  onSave: (data: NS) => void;
  onClose: () => void;
  isPending: boolean;
  error?: string;
}

function RuleForm({ existing, actions, allDevices, targetName, onSave, onClose, isPending, error }: RuleFormProps) {
  const [topics, setTopics]     = useState(existing?.['topics'] ?? '');
  const [action, setAction]     = useState(existing?.['action'] ?? (allDevices ? '' : (actions[0]?.['name'] ?? '')));
  const [prefix, setPrefix]     = useState(existing?.['prefix'] ?? '');
  const [disabled, setDisabled] = useState((existing?.['disabled'] ?? 'false') === 'true');

  const canSave = topics.trim() !== '' && action.trim() !== '';

  const title = existing
    ? 'Edit Logging Rule'
    : targetName
      ? `Add Logging Rule — ${targetName}`
      : allDevices ? 'Add Logging Rule — All Devices' : 'Add Logging Rule';

  function handleSubmit() {
    const data: NS = { topics: topics.trim(), action: action.trim() };
    if (prefix.trim()) data['prefix'] = prefix.trim();
    else if (existing) data['prefix'] = '';   // cleared on the device
    data['disabled'] = disabled ? 'yes' : 'no';
    onSave(data);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Topics <span className="text-red-500">*</span></label>
            <input className="input w-full" value={topics} onChange={e => setTopics(e.target.value)} placeholder="info,error,!debug" />
            <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
              Comma-separated. Prefix with <code className="font-mono">!</code> to exclude. Common topics: {COMMON_TOPICS}.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Action <span className="text-red-500">*</span></label>
            {allDevices || actions.length === 0 ? (
              <>
                <input className="input w-full" value={action} onChange={e => setAction(e.target.value)} placeholder="remote" />
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                  Enter the action name as it appears on each device (e.g. <code className="font-mono">remote</code>).
                </p>
              </>
            ) : (
              <select className="input w-full" value={action} onChange={e => setAction(e.target.value)}>
                {actions.map(a => <option key={a['.id']} value={a['name']}>{a['name']} ({a['type']})</option>)}
              </select>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Prefix</label>
            <input className="input w-full" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="optional message prefix" />
          </div>
          <div className="flex items-center gap-3">
            <Toggle checked={disabled} onChange={setDisabled} />
            <div className="text-sm font-medium text-gray-700 dark:text-slate-200">Disabled</div>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t border-gray-200 dark:border-slate-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors">Cancel</button>
          <button onClick={handleSubmit} disabled={!canSave || isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
            <Save className="w-3.5 h-3.5" />{isPending ? 'Saving…' : allDevices ? 'Review & Push' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add-to-device control (dropdown + button) ─────────────────────────────────

function AddToDevice({
  devices, value, onChange, onAdd,
}: {
  devices: { id: number; name: string }[];
  value: number | '';
  onChange: (id: number) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="text-xs rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-slate-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[10rem]"
        title="Choose a device to add to"
      >
        {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <button onClick={onAdd}
        className="flex items-center gap-1 px-2.5 py-1 border border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-700 text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
        <Plus className="w-3.5 h-3.5" />Add to device
      </button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NetworkServicesSyslogPage() {
  const canWrite = useCanWrite();
  const qc = useQueryClient();

  // Form state. `targetDeviceId` → single-device add; `allCoverage` → edit
  // across the devices that already have the row; neither → add to all.
  const [actionForm, setActionForm] = useState<{ existing?: NS; allCoverage?: DeviceCoverage[]; targetDeviceId?: number } | null>(null);
  const [ruleForm, setRuleForm]     = useState<{ existing?: NS; allCoverage?: DeviceCoverage[]; targetDeviceId?: number } | null>(null);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError]     = useState('');
  const [togglePending, setTogglePending] = useState(false);

  // Selected target for the per-section "Add to device" dropdowns
  const [addActionDeviceId, setAddActionDeviceId] = useState<number | ''>('');
  const [addRuleDeviceId, setAddRuleDeviceId]     = useState<number | ''>('');

  // Push / delete-all flow
  const [pendingPush, setPendingPush]     = useState<PendingOp | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState<{ type: 'action' | 'rule'; coverage: DeviceCoverage[]; label: string } | null>(null);
  const [isPushing, setIsPushing]         = useState(false);
  const [opResults, setOpResults]         = useState<{ label: string; results: PushResult[] } | null>(null);

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });

  const onlineDevices = devices.filter(d => d.status === 'online');

  // Aggregated data across all online devices
  const allDevicesKey = onlineDevices.map(d => d.id).join(',');
  const { data: allDevicesSyslog = [], isLoading: allLoading, refetch: allRefetch, isFetching: allFetching } = useQuery({
    queryKey: ['ns-syslog-all', allDevicesKey],
    queryFn: async () => {
      const results = await Promise.allSettled(
        onlineDevices.map(d => networkServicesApi.getSyslog(d.id).then(r => ({ deviceId: d.id, deviceName: d.name, ...r.data })))
      );
      return results
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<{ deviceId: number; deviceName: string; actions: NS[]; rules: NS[] }>).value);
    },
    enabled: onlineDevices.length > 0,
  });

  const aggregatedActions = aggregateActions(allDevicesSyslog);
  const aggregatedRules   = aggregateRules(allDevicesSyslog);

  // Resolve the active add-target for each section (default: first online device)
  const actionTarget = (typeof addActionDeviceId === 'number' ? addActionDeviceId : onlineDevices[0]?.id) ?? '';
  const ruleTarget   = (typeof addRuleDeviceId === 'number' ? addRuleDeviceId : onlineDevices[0]?.id) ?? '';
  const ruleTargetActions = allDevicesSyslog.find(ds => ds.deviceId === ruleTarget)?.actions ?? [];

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ['ns-syslog-all'] });
    qc.invalidateQueries({ queryKey: ['network-services-overview'] });
  }

  // ── Single-device add (direct, no review) ─────────────────────────────────
  async function handleSingleAdd(type: 'action' | 'rule', data: NS, targetDeviceId: number) {
    setSaveError(''); setSavePending(true);
    try {
      if (type === 'action') await networkServicesApi.addSyslogAction(targetDeviceId, data);
      else await networkServicesApi.addSyslogRule(targetDeviceId, data);
      setActionForm(null); setRuleForm(null);
      invalidateAll();
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSavePending(false); }
  }

  // ── All-devices add / update (review then push) ───────────────────────────
  function handleAllDevicesSave(type: 'action' | 'rule', data: NS, coverage?: DeviceCoverage[]) {
    setPendingPush({ type, operation: coverage ? 'update' : 'add', data, coverage });
    setActionForm(null); setRuleForm(null);
  }

  async function executePush() {
    if (!pendingPush) return;
    setIsPushing(true);
    const { type, operation, data, coverage } = pendingPush;
    const noun = type === 'action' ? 'action' : 'rule';
    const label = operation === 'update'
      ? `Update ${noun} "${type === 'action' ? data['name'] : data['topics']}"`
      : `Add ${noun} "${type === 'action' ? data['name'] : data['topics']}"`;

    let settled: PromiseSettledResult<unknown>[];
    let targetNames: string[];

    if (operation === 'update' && coverage) {
      settled = await Promise.allSettled(
        coverage.map(c =>
          type === 'action'
            ? networkServicesApi.updateSyslogAction(c.deviceId, c.rowId, data)
            : networkServicesApi.updateSyslogRule(c.deviceId, c.rowId, data)
        )
      );
      targetNames = coverage.map(c => c.deviceName);
    } else {
      // Skip devices that already have an identical action/rule to avoid duplicates
      const devicesToAdd = onlineDevices.filter(d => {
        const deviceSyslog = allDevicesSyslog.find(ds => ds.deviceId === d.id);
        if (!deviceSyslog) return true;
        if (type === 'action') {
          const newName = data['name'] ?? '';
          return !deviceSyslog.actions.some(a => (a['name'] ?? '') === newName);
        }
        const newKey = `${data['topics'] ?? ''}|${data['action'] ?? ''}`;
        return !deviceSyslog.rules.some(r => `${r['topics'] ?? ''}|${r['action'] ?? ''}` === newKey);
      });
      settled = await Promise.allSettled(
        devicesToAdd.map(d =>
          type === 'action'
            ? networkServicesApi.addSyslogAction(d.id, data)
            : networkServicesApi.addSyslogRule(d.id, data)
        )
      );
      targetNames = devicesToAdd.map(d => d.name);
    }

    setIsPushing(false); setPendingPush(null);
    setOpResults({
      label,
      results: targetNames.map((name, i) => ({
        name,
        success: settled[i].status === 'fulfilled',
        error: settled[i].status === 'rejected' ? (settled[i] as PromiseRejectedResult).reason?.message : undefined,
      })),
    });
    invalidateAll();
  }

  async function executeDeleteAll() {
    if (!confirmDeleteAll) return;
    setIsPushing(true);
    const { type, coverage, label } = confirmDeleteAll;
    const settled = await Promise.allSettled(
      coverage.map(c =>
        type === 'action'
          ? networkServicesApi.deleteSyslogAction(c.deviceId, c.rowId)
          : networkServicesApi.deleteSyslogRule(c.deviceId, c.rowId)
      )
    );
    setIsPushing(false); setConfirmDeleteAll(null);
    setOpResults({
      label: `Remove ${label}`,
      results: coverage.map((c, i) => ({
        name: c.deviceName,
        success: settled[i].status === 'fulfilled',
        error: settled[i].status === 'rejected' ? (settled[i] as PromiseRejectedResult).reason?.message : undefined,
      })),
    });
    invalidateAll();
  }

  async function handleToggleRuleAll(coverage: DeviceCoverage[], disabled: boolean) {
    setTogglePending(true);
    try {
      await Promise.allSettled(coverage.map(c => networkServicesApi.toggleSyslogRule(c.deviceId, c.rowId, disabled)));
      invalidateAll();
    } finally { setTogglePending(false); }
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Logging</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Syslog actions and routing rules across your fleet. Coverage shows how many devices share each entry.{' '}
            <Link to="/events" className="text-blue-600 dark:text-blue-400 hover:underline">
              View live events →
            </Link>
          </p>
        </div>
        {onlineDevices.length > 0 && (
          <button onClick={() => allRefetch()} disabled={allFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', allFetching && 'animate-spin')} />Refresh
          </button>
        )}
      </div>

      {onlineDevices.length === 0 && (
        <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">No online devices found.</div>
      )}

      {onlineDevices.length > 0 && allLoading && (
        <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading from all devices…</div>
      )}

      {onlineDevices.length > 0 && !allLoading && (
        <div className="space-y-6">
          {/* Logging Actions */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center gap-2">
              <FileText className="w-4 h-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
                Logging Actions<span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">({aggregatedActions.length} unique)</span>
              </h2>
              {canWrite && (
                <div className="ml-auto flex items-center gap-2">
                  <AddToDevice
                    devices={onlineDevices}
                    value={actionTarget}
                    onChange={setAddActionDeviceId}
                    onAdd={() => { setSaveError(''); setActionForm({ targetDeviceId: Number(actionTarget) }); }}
                  />
                  <button onClick={() => setActionForm({})}
                    className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
                    <Plus className="w-3.5 h-3.5" />Add to All Devices
                  </button>
                </div>
              )}
            </div>
            {aggregatedActions.length === 0
              ? <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No logging actions found across online devices.</div>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Name</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Type</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Destination</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Coverage</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aggregatedActions.map(({ key, sample, coverage }, i) => {
                        const isBuiltin = BUILTIN_ACTION_NAMES.includes(sample['name'] ?? '');
                        return (
                          <tr key={key}
                            className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40',
                              i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                              {sample['name']}{isBuiltin && <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">(built-in)</span>}
                            </td>
                            <td className="px-4 py-3">
                              <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                                sample['type'] === 'remote'
                                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                                  : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-400')}>
                                {sample['type']}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-700 dark:text-slate-300">
                              {sample['type'] === 'remote' ? (
                                <div>
                                  <span className="font-mono text-xs">{sample['remote'] || '—'}:{sample['remote-port'] || '514'}</span>
                                  <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                                    {sample['syslog-facility'] || 'daemon'} / {sample['syslog-severity'] || 'auto'}
                                    {sample['bsd-syslog'] === 'yes' && ' · BSD'}
                                  </div>
                                </div>
                              ) : '—'}
                            </td>
                            <td className="px-4 py-3"><CoverageBadge coverage={coverage} total={onlineDevices.length} /></td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {canWrite && (
                                  <button
                                    onClick={() => setActionForm({ existing: sample, allCoverage: coverage })}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors" title="Edit on covered devices">
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {canWrite && !isBuiltin && (
                                  <button
                                    onClick={() => setConfirmDeleteAll({ type: 'action', coverage, label: `action "${sample['name']}"` })}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-slate-700 transition-colors" title="Remove from covered devices">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </div>

          {/* Logging Rules */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center gap-2">
              <FileText className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
                Logging Rules<span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">({aggregatedRules.length} unique)</span>
              </h2>
              {canWrite && (
                <div className="ml-auto flex items-center gap-2">
                  <AddToDevice
                    devices={onlineDevices}
                    value={ruleTarget}
                    onChange={setAddRuleDeviceId}
                    onAdd={() => { setSaveError(''); setRuleForm({ targetDeviceId: Number(ruleTarget) }); }}
                  />
                  <button onClick={() => setRuleForm({})}
                    className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
                    <Plus className="w-3.5 h-3.5" />Add to All Devices
                  </button>
                </div>
              )}
            </div>
            {aggregatedRules.length === 0
              ? <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No logging rules found across online devices.</div>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Topics</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Action</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Prefix</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Status</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Coverage</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aggregatedRules.map(({ key, sample, coverage }, i) => {
                        const isDisabled = sample['disabled'] === 'true' || sample['disabled'] === 'yes';
                        return (
                          <tr key={key}
                            className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40',
                              i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                            <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-white">{sample['topics'] || '—'}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{sample['action'] || '—'}</td>
                            <td className="px-4 py-3 text-gray-500 dark:text-slate-400 text-xs">{sample['prefix'] || '—'}</td>
                            <td className="px-4 py-3">
                              <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                                isDisabled
                                  ? 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
                                  : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400')}>
                                <span className={clsx('w-1.5 h-1.5 rounded-full', isDisabled ? 'bg-gray-400' : 'bg-green-500')} />
                                {isDisabled ? 'Disabled' : 'Enabled'}
                              </span>
                            </td>
                            <td className="px-4 py-3"><CoverageBadge coverage={coverage} total={onlineDevices.length} /></td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {canWrite && (
                                  <button
                                    onClick={() => setRuleForm({ existing: sample, allCoverage: coverage })}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors" title="Edit on covered devices">
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {canWrite && (
                                  <button
                                    onClick={() => handleToggleRuleAll(coverage, !isDisabled)}
                                    disabled={togglePending}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
                                    title={isDisabled ? 'Enable on covered devices' : 'Disable on covered devices'}>
                                    <span className="text-xs font-medium">{isDisabled ? 'En' : 'Dis'}</span>
                                  </button>
                                )}
                                {canWrite && (
                                  <button
                                    onClick={() => setConfirmDeleteAll({ type: 'rule', coverage, label: `rule "${sample['topics']}"` })}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-slate-700 transition-colors" title="Remove from covered devices">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </div>

          {/* Operation results */}
          {opResults && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">{opResults.label}</h2>
                <span className="text-xs text-gray-400 dark:text-slate-500">
                  {opResults.results.filter(r => r.success).length}/{opResults.results.length} succeeded
                </span>
                <button onClick={() => setOpResults(null)} className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-slate-800">
                {opResults.results.map(r => (
                  <div key={r.name} className="flex items-center gap-3 px-5 py-2.5">
                    {r.success
                      ? <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                      : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                    <span className="text-sm font-medium text-gray-800 dark:text-slate-200">{r.name}</span>
                    {r.error && <span className="text-xs text-red-500 ml-2">{r.error}</span>}
                    {r.success && <span className="text-xs text-green-600 dark:text-green-400 ml-2">applied</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modals ───────────────────────────────────────────────────────────── */}

      {actionForm && (
        actionForm.targetDeviceId ? (
          <ActionForm existing={actionForm.existing}
            targetName={devices.find(d => d.id === actionForm.targetDeviceId)?.name}
            onSave={data => handleSingleAdd('action', data, actionForm.targetDeviceId!)}
            onClose={() => { setActionForm(null); setSaveError(''); }}
            isPending={savePending} error={saveError} />
        ) : (
          <ActionForm allDevices existing={actionForm.existing}
            onSave={data => handleAllDevicesSave('action', data, actionForm.allCoverage)}
            onClose={() => setActionForm(null)} isPending={false} />
        )
      )}

      {ruleForm && (
        ruleForm.targetDeviceId ? (
          <RuleForm existing={ruleForm.existing} actions={ruleTargetActions}
            targetName={devices.find(d => d.id === ruleForm.targetDeviceId)?.name}
            onSave={data => handleSingleAdd('rule', data, ruleForm.targetDeviceId!)}
            onClose={() => { setRuleForm(null); setSaveError(''); }}
            isPending={savePending} error={saveError} />
        ) : (
          <RuleForm allDevices existing={ruleForm.existing} actions={[]}
            onSave={data => handleAllDevicesSave('rule', data, ruleForm.allCoverage)}
            onClose={() => setRuleForm(null)} isPending={false} />
        )
      )}

      {/* Confirm push to all */}
      {pendingPush && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                  {pendingPush.operation === 'update' ? 'Update on all affected devices?' : 'Push to all online devices?'}
                </h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                  {pendingPush.operation === 'update' ? 'This will update' : 'This will add'} the {pendingPush.type === 'action' ? 'logging action' : 'logging rule'}{' '}
                  <strong>&quot;{pendingPush.type === 'action' ? pendingPush.data['name'] : pendingPush.data['topics']}&quot;</strong>{' '}
                  {pendingPush.operation === 'update' ? 'on' : 'to'}{' '}
                  <strong>
                    {pendingPush.operation === 'update' && pendingPush.coverage
                      ? `${pendingPush.coverage.length} device${pendingPush.coverage.length !== 1 ? 's' : ''}`
                      : `${onlineDevices.length} device${onlineDevices.length !== 1 ? 's' : ''}`}
                  </strong>:{' '}
                  {pendingPush.operation === 'update' && pendingPush.coverage
                    ? pendingPush.coverage.map(c => c.deviceName).join(', ')
                    : onlineDevices.map(d => d.name).join(', ')}.
                </p>
                {pendingPush.operation === 'add' && <p className="mt-2 text-xs text-gray-400 dark:text-slate-500">Offline devices are skipped automatically.</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPendingPush(null)} disabled={isPushing}
                className="px-4 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50">Cancel</button>
              <button onClick={executePush} disabled={isPushing}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
                {isPushing
                  ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />{pendingPush.operation === 'update' ? 'Updating…' : 'Pushing…'}</>
                  : pendingPush.operation === 'update' ? 'Update on All' : 'Push to All Devices'
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete from all */}
      {confirmDeleteAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Remove from devices?</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                  This will remove the <strong>{confirmDeleteAll.label}</strong> from{' '}
                  <strong>{confirmDeleteAll.coverage.length} device{confirmDeleteAll.coverage.length !== 1 ? 's' : ''}</strong>:{' '}
                  {confirmDeleteAll.coverage.map(c => c.deviceName).join(', ')}.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteAll(null)} disabled={isPushing}
                className="px-4 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50">Cancel</button>
              <button onClick={executeDeleteAll} disabled={isPushing}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
                {isPushing ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Removing…</> : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
