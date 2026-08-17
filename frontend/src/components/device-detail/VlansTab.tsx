import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, AlertCircle, RefreshCw, Pencil, Check, X, Network, Copy } from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { Vlan, SwitchPort } from '../../types';
import clsx from 'clsx';
import { useCanWrite } from '../../hooks/useCanWrite';
import CopyVlanModal from './CopyVlanModal';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';

interface PortForm {
  tagged_ports: string;
  untagged_ports: string;
}

export default function VlansTab({ deviceId, deviceName, deviceType, onGoToPorts }: {
  deviceId: number;
  deviceName?: string;
  deviceType?: string;
  onGoToPorts?: (bridgeName: string) => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  // A predicted lockout comes back as 409 with a verdict; hold it plus the retry
  // that re-sends the same change with confirm_lockout once the user accepts.
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);

  const { data: vlans = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['vlans', deviceId],
    queryFn: () => devicesApi.getVlans(deviceId).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const { data: portsData } = useQuery({
    queryKey: ['ports', deviceId],
    queryFn: () => devicesApi.getPorts(deviceId).then((r) => r.data),
  });
  const ports: SwitchPort[] = portsData?.ports ?? [];

  // Find bridges where vlan-filtering is not enabled (stored as 'yes' from RouterOS or 'true' after toggle)
  const bridgesWithoutFiltering = ports.filter(
    (p) => p.type === 'bridge' && p.config_json?.['vlan-filtering'] !== 'yes' && p.config_json?.['vlan-filtering'] !== 'true'
  );

  // ── Copy VLAN modal ──
  const [showCopyModal, setShowCopyModal] = useState(false);

  // ── Add form ──
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ vlan_id: '', bridge: '', tagged_ports: '', untagged_ports: '' });
  const [addError, setAddError] = useState('');

  // ── Edit form ──
  const [editingVlan, setEditingVlan] = useState<Vlan | null>(null);
  const [editForm, setEditForm] = useState<PortForm>({ tagged_ports: '', untagged_ports: '' });
  const [editError, setEditError] = useState('');

  // ── Delete error ──
  const [deleteError, setDeleteError] = useState('');

  const bridgeOptions = [...new Set((vlans as Vlan[]).map((v) => v.bridge).filter(Boolean))];

  // ── Mutations ──
  const addMutation = useMutation({
    mutationFn: (confirm: boolean) => {
      const tagged = addForm.tagged_ports.split(',').map((s) => s.trim()).filter(Boolean);
      const untagged = addForm.untagged_ports.split(',').map((s) => s.trim()).filter(Boolean);
      return devicesApi.addVlan(deviceId, {
        bridge: addForm.bridge,
        vlan_id: parseInt(addForm.vlan_id, 10),
        tagged_ports: tagged,
        untagged_ports: untagged,
        ...(confirm ? { confirm_lockout: true } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vlans', deviceId] });
      setAddForm({ vlan_id: '', bridge: bridgeOptions[0] || '', tagged_ports: '', untagged_ports: '' });
      setShowAdd(false);
      setAddError('');
      setLockout(null);
    },
    onError: (err: unknown) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => addMutation.mutate(true) }); return; }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setAddError(msg || 'Failed to add VLAN');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (confirm: boolean) => {
      if (!editingVlan) throw new Error('No VLAN selected');
      const tagged = editForm.tagged_ports.split(',').map((s) => s.trim()).filter(Boolean);
      const untagged = editForm.untagged_ports.split(',').map((s) => s.trim()).filter(Boolean);
      return devicesApi.updateVlan(deviceId, editingVlan.id, {
        tagged_ports: tagged,
        untagged_ports: untagged,
        ...(confirm ? { confirm_lockout: true } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vlans', deviceId] });
      setEditingVlan(null);
      setEditError('');
      setLockout(null);
    },
    onError: (err: unknown) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => updateMutation.mutate(true) }); return; }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setEditError(msg || 'Failed to update VLAN');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ vlanDbId, confirm = false }: { vlanDbId: number; confirm?: boolean }) =>
      devicesApi.deleteVlan(deviceId, vlanDbId, confirm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vlans', deviceId] });
      setDeleteError('');
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => deleteMutation.mutate({ vlanDbId: vars.vlanDbId, confirm: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setDeleteError(msg || 'Failed to delete VLAN');
    },
  });

  const openEdit = (vlan: Vlan) => {
    setEditingVlan(vlan);
    setEditError('');
    setShowAdd(false);
    setEditForm({
      tagged_ports: (vlan.tagged_ports ?? []).join(', '),
      untagged_ports: (vlan.untagged_ports ?? []).join(', '),
    });
  };

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading...</div>;

  return (
    <div className="space-y-4">
      {/* VLAN Filtering warning */}
      {bridgesWithoutFiltering.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
          <Network className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm text-amber-800 dark:text-amber-300">
            <span className="font-semibold">VLAN Filtering is not enabled</span> on the Bridge interface
            {bridgesWithoutFiltering.length > 1
              ? ` (${bridgesWithoutFiltering.map((b) => b.name).join(', ')})`
              : ` (${bridgesWithoutFiltering[0].name})`}.
            {' '}VLAN functionality is disabled — tagging and untagging rules will not be enforced.{' '}
            {onGoToPorts && (
              <button
                onClick={() => onGoToPorts(bridgesWithoutFiltering[0].name)}
                className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200 transition-colors"
              >
                Enable VLAN Filtering on the Bridge interface →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div>
          {deleteError && (
            <span className="text-sm text-red-500 flex items-center gap-1">
              <AlertCircle className="w-4 h-4" />{deleteError}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
            Refresh
          </button>
          {canWrite && deviceType === 'switch' && (
            <button
              onClick={() => setShowCopyModal(true)}
              className="btn-secondary flex items-center gap-2 text-sm"
              title="Copy VLANs from another switch"
            >
              <Copy className="w-4 h-4" />
              Copy from Switch
            </button>
          )}
          {canWrite && (
            <button
              onClick={() => {
                setShowAdd(!showAdd);
                setEditingVlan(null);
                setAddError('');
                setAddForm({ vlan_id: '', bridge: bridgeOptions[0] || '', tagged_ports: '', untagged_ports: '' });
              }}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <Plus className="w-4 h-4" />
              Add VLAN
            </button>
          )}
        </div>
      </div>

      {/* Add VLAN form */}
      {canWrite && showAdd && (
        <div className="card p-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">New Bridge VLAN</h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="label">VLAN ID (1–4094)</label>
              <input
                type="number"
                className="input"
                value={addForm.vlan_id}
                onChange={(e) => setAddForm((f) => ({ ...f, vlan_id: e.target.value }))}
                min={1} max={4094}
                placeholder="10"
              />
            </div>
            <div>
              <label className="label">Bridge</label>
              {bridgeOptions.length > 0 ? (
                <select
                  className="input"
                  value={addForm.bridge}
                  onChange={(e) => setAddForm((f) => ({ ...f, bridge: e.target.value }))}
                >
                  {bridgeOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              ) : (
                <input
                  className="input font-mono"
                  value={addForm.bridge}
                  onChange={(e) => setAddForm((f) => ({ ...f, bridge: e.target.value }))}
                  placeholder="bridge1"
                />
              )}
            </div>
            <div>
              <label className="label">Tagged Ports</label>
              <input
                className="input font-mono"
                value={addForm.tagged_ports}
                onChange={(e) => setAddForm((f) => ({ ...f, tagged_ports: e.target.value }))}
                placeholder="ether1, ether2"
              />
              <p className="text-xs text-gray-400 mt-1">Comma-separated</p>
            </div>
            <div>
              <label className="label">Untagged Ports</label>
              <input
                className="input font-mono"
                value={addForm.untagged_ports}
                onChange={(e) => setAddForm((f) => ({ ...f, untagged_ports: e.target.value }))}
                placeholder="ether3"
              />
              <p className="text-xs text-gray-400 mt-1">Comma-separated</p>
            </div>
          </div>
          {addError && (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" /> {addError}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => addMutation.mutate(false)}
              disabled={!addForm.vlan_id || !addForm.bridge || addMutation.isPending}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              {addMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              Add VLAN
            </button>
            <button onClick={() => setShowAdd(false)} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Edit VLAN panel */}
      {canWrite && editingVlan && (
        <div className="card p-4 space-y-3 border-blue-300 dark:border-blue-600 border-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
              Edit VLAN{' '}
              <span className="font-mono text-blue-600 dark:text-blue-400">{editingVlan.vlan_id}</span>
              {editingVlan.bridge && (
                <span className="text-gray-400 dark:text-slate-500 font-normal"> on {editingVlan.bridge}</span>
              )}
            </h4>
            <button onClick={() => setEditingVlan(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Tagged Ports</label>
              <input
                className="input font-mono"
                value={editForm.tagged_ports}
                onChange={(e) => setEditForm((f) => ({ ...f, tagged_ports: e.target.value }))}
                placeholder="ether1, ether2"
                autoFocus
              />
              <p className="text-xs text-gray-400 mt-1">Comma-separated interface names</p>
            </div>
            <div>
              <label className="label">Untagged Ports</label>
              <input
                className="input font-mono"
                value={editForm.untagged_ports}
                onChange={(e) => setEditForm((f) => ({ ...f, untagged_ports: e.target.value }))}
                placeholder="ether3"
              />
              <p className="text-xs text-gray-400 mt-1">Comma-separated interface names</p>
            </div>
          </div>

          {editError && (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" /> {editError}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => updateMutation.mutate(false)}
              disabled={updateMutation.isPending}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              {updateMutation.isPending
                ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                : <Check className="w-3.5 h-3.5" />}
              Save Changes
            </button>
            <button onClick={() => setEditingVlan(null)} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {showCopyModal && (
        <CopyVlanModal
          deviceId={deviceId}
          deviceName={deviceName ?? `Device ${deviceId}`}
          onClose={() => {
            setShowCopyModal(false);
            queryClient.invalidateQueries({ queryKey: ['vlans', deviceId] });
          }}
        />
      )}

      {/* VLANs table */}
      <div className="card overflow-hidden">
        {(vlans as Vlan[]).length === 0 ? (
          <div className="text-center py-8 text-gray-400 dark:text-slate-500">
            No VLANs configured on this device, or device not synced yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="table-header px-4 py-2.5 text-left">VLAN ID</th>
                <th className="table-header px-4 py-2.5 text-left">Name</th>
                <th className="table-header px-4 py-2.5 text-left">Bridge</th>
                <th className="table-header px-4 py-2.5 text-left">Tagged Ports</th>
                <th className="table-header px-4 py-2.5 text-left">Untagged Ports</th>
                {canWrite && <th className="table-header px-4 py-2.5 w-16" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {(vlans as Vlan[]).map((vlan) => (
                <tr
                  key={vlan.id}
                  className={clsx(
                    'hover:bg-gray-50 dark:hover:bg-slate-700/30',
                    editingVlan?.id === vlan.id && 'bg-blue-50 dark:bg-blue-900/10'
                  )}
                >
                  <td className="px-4 py-2.5 font-mono font-bold text-blue-600 dark:text-blue-400">
                    {vlan.vlan_id}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                    {vlan.name || `VLAN ${vlan.vlan_id}`}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-gray-500 dark:text-slate-400">
                    {vlan.bridge || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {(vlan.tagged_ports ?? []).map((p) => (
                        <span key={p} className="px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs rounded font-mono">
                          {p}
                        </span>
                      ))}
                      {!(vlan.tagged_ports?.length) && '—'}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {(vlan.untagged_ports ?? []).map((p) => (
                        <span key={p} className="px-1.5 py-0.5 bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 text-xs rounded font-mono">
                          {p}
                        </span>
                      ))}
                      {!(vlan.untagged_ports?.length) && '—'}
                    </div>
                  </td>
                  {canWrite && (
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(vlan)}
                          className={clsx(
                            'p-1 rounded transition-colors',
                            editingVlan?.id === vlan.id
                              ? 'text-blue-500 bg-blue-100 dark:bg-blue-900/30'
                              : 'text-gray-400 hover:text-blue-500 hover:bg-gray-100 dark:hover:bg-slate-700'
                          )}
                          title="Edit VLAN"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Remove VLAN ${vlan.vlan_id} from ${vlan.bridge}?`)) {
                              deleteMutation.mutate({ vlanDbId: vlan.id });
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                          title="Delete VLAN"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {lockout && (
        <LockoutVerdictDialog
          verdict={lockout.verdict}
          confirmPhrase={deviceName || 'confirm'}
          pending={addMutation.isPending || updateMutation.isPending || deleteMutation.isPending}
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}
    </div>
  );
}
