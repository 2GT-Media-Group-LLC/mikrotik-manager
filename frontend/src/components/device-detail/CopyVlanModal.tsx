import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, ChevronRight, Copy, AlertTriangle, Check, RefreshCw, Info } from 'lucide-react';
import { devicesApi } from '../../services/api';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import type { Device, Vlan, SwitchPort } from '../../types';
import clsx from 'clsx';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;
type PortAssignment = 'none' | 'tagged' | 'untagged';
type ConflictChoice = 'skip' | 'overwrite';
type OpStatus = 'add' | 'identical' | 'conflict';

interface AnalyzedOp {
  sourceVlan: Vlan;
  status: OpStatus;
  targetBridge: string;
  bridgeExistsOnTarget: boolean;
  effectiveTagged: string[];
  effectiveUntagged: string[];
  existingVlan?: Vlan;
  conflictChoice: ConflictChoice;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function arraysEqualAsSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: Step }) {
  const labels = ['Select VLANs', 'Assign Ports', 'Confirm'];
  return (
    <div className="flex items-center gap-0 px-5 py-3 border-b border-gray-200 dark:border-slate-700 shrink-0">
      {labels.map((label, i) => (
        <div key={i} className="flex items-center">
          <span className={clsx(
            'flex items-center gap-1.5 text-xs font-medium',
            step === i + 1 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-slate-500'
          )}>
            <span className={clsx(
              'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
              step > i + 1
                ? 'bg-blue-500 text-white'
                : step === i + 1
                  ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400'
                  : 'bg-gray-100 text-gray-400 dark:bg-slate-700 dark:text-slate-500'
            )}>
              {step > i + 1 ? '✓' : i + 1}
            </span>
            {label}
          </span>
          {i < 2 && (
            <ChevronRight className="w-3 h-3 mx-2 text-gray-300 dark:text-slate-600 shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ op }: { op: AnalyzedOp }) {
  if (op.status === 'add') {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        NEW
      </span>
    );
  }
  if (op.status === 'identical') {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400">
        IDENTICAL
      </span>
    );
  }
  return op.conflictChoice === 'overwrite' ? (
    <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
      OVERWRITE
    </span>
  ) : (
    <span className="px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400">
      SKIP
    </span>
  );
}

// Interactive port chip — cycles None → Tagged → Untagged → None on click
function PortChip({
  name,
  assignment,
  onClick,
}: {
  name: string;
  assignment: PortAssignment;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        assignment === 'none'
          ? 'Click to set Tagged'
          : assignment === 'tagged'
          ? 'Click to set Untagged'
          : 'Click to remove'
      }
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-1 rounded font-mono text-xs transition-all select-none',
        assignment === 'none' &&
          'bg-gray-100 text-gray-400 dark:bg-slate-800 dark:text-slate-500 hover:bg-gray-200 dark:hover:bg-slate-700',
        assignment === 'tagged' &&
          'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 ring-1 ring-blue-400 dark:ring-blue-500',
        assignment === 'untagged' &&
          'bg-slate-200 text-slate-700 dark:bg-slate-600 dark:text-slate-200 ring-1 ring-slate-400 dark:ring-slate-500'
      )}
    >
      {name}
      {assignment === 'tagged' && (
        <span className="text-[9px] font-bold leading-none bg-blue-500 text-white rounded px-0.5">T</span>
      )}
      {assignment === 'untagged' && (
        <span className="text-[9px] font-bold leading-none bg-slate-500 text-white rounded px-0.5">U</span>
      )}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CopyVlanModal({
  deviceId,
  deviceName,
  onClose,
}: {
  deviceId: number;
  deviceName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // The copy runs under Change Guard and is checked as one batch; overwriting
  // the management VLAN's membership comes back as a lockout to confirm.
  const guard = useGuardedWrite();

  // ── Step state ──
  const [step, setStep] = useState<Step>(1);

  // ── Step 1 state ──
  const [sourceDeviceId, setSourceDeviceId] = useState<number | null>(null);
  const [selectedVlanIds, setSelectedVlanIds] = useState<Set<number>>(new Set());

  // ── Step 2 user assignments ──
  // portAssignments[vlan_id][portName] = 'tagged' | 'untagged' | 'none'
  const [portAssignments, setPortAssignments] = useState<Record<number, Record<string, PortAssignment>>>({});
  const [bridgeOverrides, setBridgeOverrides] = useState<Record<number, string>>({});
  const [conflictChoices, setConflictChoices] = useState<Record<number, ConflictChoice>>({});

  // ── Step 3 results ──
  const [applyResults, setApplyResults] = useState<
    { vlan_id: number; action: string; success: boolean; error?: string }[] | null
  >(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: allDevices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
  });
  const switchDevices = (allDevices as Device[]).filter(
    (d) => d.device_type === 'switch' && d.id !== deviceId
  );

  const { data: sourceVlans = [], isLoading: loadingSource } = useQuery({
    queryKey: ['vlans', sourceDeviceId],
    queryFn: () => devicesApi.getVlans(sourceDeviceId!).then((r) => r.data),
    enabled: sourceDeviceId != null,
  });

  const { data: targetVlans = [] } = useQuery({
    queryKey: ['vlans', deviceId],
    queryFn: () => devicesApi.getVlans(deviceId).then((r) => r.data),
  });

  const { data: targetPortsData } = useQuery({
    queryKey: ['ports', deviceId],
    queryFn: () => devicesApi.getPorts(deviceId).then((r) => r.data),
  });
  const targetPorts = useMemo<SwitchPort[]>(
    () => targetPortsData?.ports ?? [],
    [targetPortsData]
  );

  const targetBridgeNames = useMemo(
    () => targetPorts.filter((p) => p.type === 'bridge').map((p) => p.name).sort(naturalSort),
    [targetPorts]
  );

  // Ports available for assignment: everything except VLAN-type interfaces
  const assignablePorts = useMemo(
    () =>
      targetPorts
        .filter((p) => p.type !== 'vlan')
        .map((p) => p.name)
        .sort(naturalSort),
    [targetPorts]
  );

  // ── Side-effects ───────────────────────────────────────────────────────────

  useEffect(() => {
    setSelectedVlanIds(new Set());
    setBridgeOverrides({});
    setConflictChoices({});
    setPortAssignments({});
  }, [sourceDeviceId]);

  // Auto-select all except VLAN 1 when source VLANs load
  useEffect(() => {
    if ((sourceVlans as Vlan[]).length > 0) {
      setSelectedVlanIds(
        new Set((sourceVlans as Vlan[]).filter((v) => v.vlan_id !== 1).map((v) => v.vlan_id))
      );
    }
  }, [sourceVlans]);

  // ── Port assignment helpers ────────────────────────────────────────────────

  const cyclePort = (vlanId: number, portName: string) => {
    setPortAssignments((prev) => {
      const current: PortAssignment = prev[vlanId]?.[portName] ?? 'none';
      const next: PortAssignment =
        current === 'none' ? 'tagged' : current === 'tagged' ? 'untagged' : 'none';
      return { ...prev, [vlanId]: { ...(prev[vlanId] ?? {}), [portName]: next } };
    });
  };

  const getAssignment = (vlanId: number, portName: string): PortAssignment =>
    portAssignments[vlanId]?.[portName] ?? 'none';

  const getEffective = (vlanId: number) => {
    const entries = Object.entries(portAssignments[vlanId] ?? {});
    return {
      tagged: entries.filter(([, v]) => v === 'tagged').map(([k]) => k).sort(naturalSort),
      untagged: entries.filter(([, v]) => v === 'untagged').map(([k]) => k).sort(naturalSort),
    };
  };

  // ── Analysis (memoized) ────────────────────────────────────────────────────

  const analyzedOps = useMemo((): AnalyzedOp[] => {
    return (sourceVlans as Vlan[])
      .filter((sv) => selectedVlanIds.has(sv.vlan_id))
      .map((sv) => {
        const sourceBridge = sv.bridge ?? '';
        const targetBridge =
          bridgeOverrides[sv.vlan_id] ??
          (targetBridgeNames.includes(sourceBridge)
            ? sourceBridge
            : targetBridgeNames[0] ?? sourceBridge);
        const bridgeExistsOnTarget = targetBridgeNames.includes(targetBridge);

        const { tagged: effectiveTagged, untagged: effectiveUntagged } = getEffective(sv.vlan_id);

        const existingVlan = (targetVlans as Vlan[]).find((v) => v.vlan_id === sv.vlan_id);
        let status: OpStatus;
        if (!existingVlan) {
          status = 'add';
        } else {
          const isIdentical =
            existingVlan.bridge === targetBridge &&
            arraysEqualAsSet(existingVlan.tagged_ports ?? [], effectiveTagged) &&
            arraysEqualAsSet(existingVlan.untagged_ports ?? [], effectiveUntagged);
          status = isIdentical ? 'identical' : 'conflict';
        }

        return {
          sourceVlan: sv,
          status,
          targetBridge,
          bridgeExistsOnTarget,
          effectiveTagged,
          effectiveUntagged,
          existingVlan,
          conflictChoice: conflictChoices[sv.vlan_id] ?? 'skip',
        };
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceVlans, selectedVlanIds, targetVlans, targetBridgeNames, bridgeOverrides, conflictChoices, portAssignments]);

  const toApply = analyzedOps.filter(
    (op) => op.status === 'add' || (op.status === 'conflict' && op.conflictChoice === 'overwrite')
  );

  const hasVlan1Selected = selectedVlanIds.has(1);

  // ── Mutation ───────────────────────────────────────────────────────────────

  const applyMutation = useMutation({
    mutationFn: (confirm: boolean) =>
      devicesApi.copyVlans(
        deviceId,
        toApply.map((op) => ({
          action: op.status === 'add' ? 'add' : 'update',
          vlan_id: op.sourceVlan.vlan_id,
          bridge: op.targetBridge,
          tagged_ports: op.effectiveTagged,
          untagged_ports: op.effectiveUntagged,
        })),
        confirm,
      ),
    onSuccess: (res) => {
      // No results when contact was lost and the device restored itself.
      setApplyResults(res.data.results ?? []);
      guard.onSuccess(res);
      queryClient.invalidateQueries({ queryKey: ['vlans', deviceId] });
    },
  });
  const apply = () => applyMutation.mutate(false, {
    onError: guard.onError(() => applyMutation.mutate(true), () => { /* shown below */ }),
  });

  // ── Toggle helpers ─────────────────────────────────────────────────────────

  const toggleVlan = (vlanId: number) =>
    setSelectedVlanIds((prev) => {
      const next = new Set(prev);
      if (next.has(vlanId)) { next.delete(vlanId); } else { next.add(vlanId); }
      return next;
    });

  const selectAll = () =>
    setSelectedVlanIds(new Set((sourceVlans as Vlan[]).map((v) => v.vlan_id)));

  const selectNone = () => setSelectedVlanIds(new Set());

  // ── Step 1 ─────────────────────────────────────────────────────────────────

  const renderStep1 = () => (
    <div className="space-y-4">
      <div>
        <label className="label">Source switch</label>
        <select
          className="input"
          value={sourceDeviceId ?? ''}
          onChange={(e) => setSourceDeviceId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Select a switch…</option>
          {switchDevices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.ip_address}){d.status !== 'online' ? ' — offline' : ''}
            </option>
          ))}
        </select>
        {switchDevices.length === 0 && (
          <p className="text-xs text-gray-400 mt-1.5">
            No other switches found. Add another switch device first.
          </p>
        )}
      </div>

      {sourceDeviceId != null && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-slate-300">
              {loadingSource
                ? 'Loading VLANs…'
                : `VLANs on ${switchDevices.find((d) => d.id === sourceDeviceId)?.name ?? 'source'}`}
            </span>
            {!loadingSource && (sourceVlans as Vlan[]).length > 0 && (
              <div className="flex gap-2">
                <button onClick={selectAll} className="text-xs text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
                  Select all
                </button>
                <span className="text-gray-300 dark:text-slate-600">·</span>
                <button onClick={selectNone} className="text-xs text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
                  Deselect all
                </button>
              </div>
            )}
          </div>

          {loadingSource && (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
              <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}

          {!loadingSource && (sourceVlans as Vlan[]).length === 0 && (
            <p className="text-sm text-gray-400 py-3">No VLANs found on this device.</p>
          )}

          {!loadingSource && (sourceVlans as Vlan[]).length > 0 && (
            <div className="rounded-lg border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-700 overflow-hidden">
              {(sourceVlans as Vlan[]).map((vlan) => {
                const isVlan1 = vlan.vlan_id === 1;
                const checked = selectedVlanIds.has(vlan.vlan_id);
                return (
                  <label
                    key={vlan.vlan_id}
                    className={clsx(
                      'flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors select-none',
                      checked
                        ? 'bg-blue-50 dark:bg-blue-900/10'
                        : 'hover:bg-gray-50 dark:hover:bg-slate-700/30'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={checked}
                      onChange={() => toggleVlan(vlan.vlan_id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-sm text-blue-600 dark:text-blue-400">
                          VLAN {vlan.vlan_id}
                        </span>
                        {vlan.name && (
                          <span className="text-sm text-gray-700 dark:text-slate-300">{vlan.name}</span>
                        )}
                        {vlan.bridge && (
                          <span className="text-xs text-gray-400 font-mono">{vlan.bridge}</span>
                        )}
                        {isVlan1 && (
                          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3 h-3" /> management risk
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                        Port assignments will be configured in the next step
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {hasVlan1Selected && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                <strong>VLAN 1 is selected.</strong> This is often the default management VLAN.
                Take care when assigning ports to avoid losing device reachability.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ── Step 2 ─────────────────────────────────────────────────────────────────

  const renderStep2 = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-sm text-gray-500 dark:text-slate-400">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-blue-400" />
        <span>
          For each VLAN, choose which interfaces on <strong>{deviceName}</strong> should participate and how.
          Click a port to cycle: <span className="font-medium text-gray-600 dark:text-slate-300">None</span>
          {' → '}
          <span className="font-medium text-blue-600 dark:text-blue-400">Tagged</span>
          {' → '}
          <span className="font-medium text-slate-600 dark:text-slate-300">Untagged</span>
          {' → '}
          <span className="font-medium text-gray-400">None</span>.
          You can also leave all ports unassigned and configure them later.
        </span>
      </div>

      {assignablePorts.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            No interfaces detected on this device yet. Run a sync first so ports can be listed here.
            You can still proceed and configure ports manually in the VLAN editor afterward.
          </span>
        </div>
      )}

      {analyzedOps.map((op) => {
        const { tagged: effTagged, untagged: effUntagged } = getEffective(op.sourceVlan.vlan_id);
        const isSkipped = op.status === 'identical' || (op.status === 'conflict' && op.conflictChoice === 'skip');

        return (
          <div
            key={op.sourceVlan.vlan_id}
            className={clsx(
              'rounded-lg border p-4 space-y-3',
              op.status === 'add' && 'border-green-200 dark:border-green-800/60',
              op.status === 'conflict' && 'border-amber-200 dark:border-amber-700/50',
              op.status === 'identical' && 'border-gray-200 dark:border-slate-700 opacity-60'
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                  VLAN {op.sourceVlan.vlan_id}
                </span>
                {op.sourceVlan.name && (
                  <span className="text-sm text-gray-700 dark:text-slate-300">{op.sourceVlan.name}</span>
                )}
              </div>
              <StatusBadge op={op} />
            </div>

            {op.status === 'identical' && (
              <p className="text-xs text-gray-400 dark:text-slate-500">
                Your port assignment matches what&apos;s already on this device — nothing to change.
              </p>
            )}

            {/* Conflict notice + resolution */}
            {op.status === 'conflict' && (
              <div className="rounded-md border border-amber-200 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-900/10 px-3 py-2.5 space-y-2">
                <div className="text-xs text-amber-700 dark:text-amber-400">
                  <span className="font-medium">Already on this device</span>
                  {' — '}
                  tagged: {op.existingVlan?.tagged_ports?.join(', ') || '—'}
                  {' · '}
                  untagged: {op.existingVlan?.untagged_ports?.join(', ') || '—'}
                  {op.existingVlan?.bridge && ` · ${op.existingVlan.bridge}`}
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-500 dark:text-slate-400">Resolution:</span>
                  <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name={`conflict-${op.sourceVlan.vlan_id}`}
                      checked={op.conflictChoice === 'skip'}
                      onChange={() =>
                        setConflictChoices((prev) => ({ ...prev, [op.sourceVlan.vlan_id]: 'skip' }))
                      }
                    />
                    Skip
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name={`conflict-${op.sourceVlan.vlan_id}`}
                      checked={op.conflictChoice === 'overwrite'}
                      onChange={() =>
                        setConflictChoices((prev) => ({ ...prev, [op.sourceVlan.vlan_id]: 'overwrite' }))
                      }
                    />
                    Overwrite with my assignments below
                  </label>
                </div>
              </div>
            )}

            {/* Bridge picker */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500 dark:text-slate-400 text-xs w-12 shrink-0">Bridge</span>
              {targetBridgeNames.length > 0 ? (
                <select
                  className="input py-1 text-xs font-mono max-w-[180px]"
                  value={op.targetBridge}
                  disabled={isSkipped}
                  onChange={(e) =>
                    setBridgeOverrides((prev) => ({
                      ...prev,
                      [op.sourceVlan.vlan_id]: e.target.value,
                    }))
                  }
                >
                  {targetBridgeNames.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="input py-1 text-xs font-mono max-w-[180px]"
                  value={op.targetBridge}
                  placeholder="bridge1"
                  disabled={isSkipped}
                  onChange={(e) =>
                    setBridgeOverrides((prev) => ({
                      ...prev,
                      [op.sourceVlan.vlan_id]: e.target.value,
                    }))
                  }
                />
              )}
              {op.bridgeExistsOnTarget ? (
                <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
              ) : (
                <span className="text-xs text-amber-500 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> not found on target
                </span>
              )}
            </div>

            {/* Port assignment */}
            <div className={clsx('space-y-2', isSkipped && 'opacity-40 pointer-events-none')}>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 dark:text-slate-400">Interfaces</span>
                {assignablePorts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      // Reset all ports for this VLAN to none
                      setPortAssignments((prev) => ({ ...prev, [op.sourceVlan.vlan_id]: {} }));
                    }}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
                  >
                    Clear all
                  </button>
                )}
              </div>

              {assignablePorts.length === 0 ? (
                <p className="text-xs text-gray-400 italic">
                  No interfaces detected — sync the device first.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {assignablePorts.map((portName) => (
                    <PortChip
                      key={portName}
                      name={portName}
                      assignment={getAssignment(op.sourceVlan.vlan_id, portName)}
                      onClick={() => cyclePort(op.sourceVlan.vlan_id, portName)}
                    />
                  ))}
                </div>
              )}

              {/* Live summary of current assignment */}
              {(effTagged.length > 0 || effUntagged.length > 0) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs pt-1 border-t border-gray-100 dark:border-slate-700/50">
                  {effTagged.length > 0 && (
                    <span className="text-gray-500 dark:text-slate-400">
                      <span className="font-medium text-blue-600 dark:text-blue-400">Tagged:</span>{' '}
                      {effTagged.join(', ')}
                    </span>
                  )}
                  {effUntagged.length > 0 && (
                    <span className="text-gray-500 dark:text-slate-400">
                      <span className="font-medium text-slate-600 dark:text-slate-300">Untagged:</span>{' '}
                      {effUntagged.join(', ')}
                    </span>
                  )}
                </div>
              )}
              {effTagged.length === 0 && effUntagged.length === 0 && assignablePorts.length > 0 && (
                <p className="text-xs text-gray-400 dark:text-slate-500 italic pt-1">
                  No ports assigned — VLAN will be created with no port memberships.
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  // ── Step 3 ─────────────────────────────────────────────────────────────────

  const renderStep3 = () => {
    if (applyResults) {
      const succeeded = applyResults.filter((r) => r.success);
      const failed = applyResults.filter((r) => !r.success);
      return (
        <div className="space-y-3">
          {succeeded.length > 0 && (
            <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10 px-4 py-3 space-y-1">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                {succeeded.length} VLAN{succeeded.length !== 1 ? 's' : ''} applied successfully
              </p>
              {succeeded.map((r) => (
                <div key={r.vlan_id} className="flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  <span>VLAN {r.vlan_id} — {r.action === 'add' ? 'added' : 'updated'}</span>
                </div>
              ))}
            </div>
          )}
          {failed.length > 0 && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-4 py-3 space-y-1">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                {failed.length} VLAN{failed.length !== 1 ? 's' : ''} failed
              </p>
              {failed.map((r) => (
                <div key={r.vlan_id} className="text-sm text-red-600 dark:text-red-400">
                  <span className="font-mono">VLAN {r.vlan_id}</span>
                  {r.error && <span className="ml-2 text-xs opacity-75">{r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    const skipped = analyzedOps.filter(
      (op) =>
        op.status === 'identical' ||
        (op.status === 'conflict' && op.conflictChoice === 'skip')
    );

    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-slate-400">
          {toApply.length > 0 ? (
            <>
              <strong>{toApply.length}</strong> VLAN{toApply.length !== 1 ? 's' : ''} will be applied to{' '}
              <strong>{deviceName}</strong>.
              {skipped.length > 0 && (
                <> <strong>{skipped.length}</strong> will be skipped.</>
              )}
            </>
          ) : (
            <>No VLANs will be applied — all selected VLANs are either identical or set to skip.</>
          )}
        </p>

        <div className="rounded-lg border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-700 overflow-hidden">
          {analyzedOps.map((op) => {
            const willApply =
              op.status === 'add' ||
              (op.status === 'conflict' && op.conflictChoice === 'overwrite');
            return (
              <div key={op.sourceVlan.vlan_id} className="px-4 py-3 flex items-start gap-3">
                <div
                  className={clsx(
                    'mt-1 w-2 h-2 rounded-full shrink-0',
                    willApply ? 'bg-green-500' : 'bg-gray-300 dark:bg-slate-600'
                  )}
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-sm text-blue-600 dark:text-blue-400">
                      VLAN {op.sourceVlan.vlan_id}
                    </span>
                    {op.sourceVlan.name && (
                      <span className="text-sm text-gray-600 dark:text-slate-400">
                        {op.sourceVlan.name}
                      </span>
                    )}
                    <StatusBadge op={op} />
                    <span className="text-xs text-gray-400 font-mono">{op.targetBridge}</span>
                  </div>

                  {willApply && (
                    <div className="flex flex-wrap gap-1">
                      {op.effectiveTagged.map((p) => (
                        <span
                          key={p}
                          className="px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs rounded font-mono"
                        >
                          {p} T
                        </span>
                      ))}
                      {op.effectiveUntagged.map((p) => (
                        <span
                          key={p}
                          className="px-1.5 py-0.5 bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 text-xs rounded font-mono"
                        >
                          {p} U
                        </span>
                      ))}
                      {op.effectiveTagged.length === 0 && op.effectiveUntagged.length === 0 && (
                        <span className="text-xs text-gray-400 italic">no port assignments</span>
                      )}
                    </div>
                  )}

                  {op.status === 'conflict' && op.conflictChoice === 'skip' && (
                    <p className="text-xs text-gray-400">Conflict — you chose to skip</p>
                  )}
                  {op.status === 'identical' && (
                    <p className="text-xs text-gray-400">Already configured identically — skipped</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {applyMutation.isError && !guard.lockout && (
          <div className="text-sm text-red-500">
            Failed to apply:{' '}
            {(applyMutation.error as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
              ?? (applyMutation.error as { message?: string })?.message ?? 'Unknown error'}
          </div>
        )}
        <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={applyMutation.isPending} />
      </div>
    );
  };

  // ── Footer ─────────────────────────────────────────────────────────────────

  const renderFooter = () => {
    if (step === 1) {
      return (
        <>
          <button onClick={onClose} className="btn-secondary text-sm">
            Cancel
          </button>
          <button
            className="btn-primary flex items-center gap-2 text-sm"
            disabled={selectedVlanIds.size === 0 || sourceDeviceId == null}
            onClick={() => setStep(2)}
          >
            Assign Ports <ChevronRight className="w-4 h-4" />
          </button>
        </>
      );
    }
    if (step === 2) {
      return (
        <>
          <button
            onClick={() => setStep(1)}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <ChevronRight className="w-4 h-4 rotate-180" /> Back
          </button>
          <button
            className="btn-primary flex items-center gap-2 text-sm"
            onClick={() => setStep(3)}
          >
            Review plan <ChevronRight className="w-4 h-4" />
          </button>
        </>
      );
    }
    // step === 3
    if (applyResults) {
      return (
        <div className="w-full flex justify-end">
          <button onClick={onClose} className="btn-primary text-sm">
            Close
          </button>
        </div>
      );
    }
    return (
      <>
        <button
          onClick={() => setStep(2)}
          className="btn-secondary flex items-center gap-2 text-sm"
          disabled={applyMutation.isPending}
        >
          <ChevronRight className="w-4 h-4 rotate-180" /> Back
        </button>
        <button
          className="btn-primary flex items-center gap-2 text-sm"
          disabled={toApply.length === 0 || applyMutation.isPending}
          onClick={apply}
        >
          {applyMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
          {applyMutation.isPending
            ? 'Applying…'
            : `Apply ${toApply.length} VLAN${toApply.length !== 1 ? 's' : ''}`}
        </button>
      </>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700 shrink-0">
          <div className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-blue-500" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Copy VLANs from Another Switch
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <StepIndicator step={step} />

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 p-5">
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200 dark:border-slate-700 shrink-0 bg-gray-50 dark:bg-slate-800/50">
          {renderFooter()}
        </div>
      </div>
    </div>
  );
}
