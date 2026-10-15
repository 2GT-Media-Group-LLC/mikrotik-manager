import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Cpu, AlertTriangle, Pencil, Trash2, Check, X, Plus, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type SwitchVlanView } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { guardOutcomeMessage, type GuardResult } from '../ChangeGuardDialog';

const MODE_HELP: Record<string, string> = {
  disabled: 'The VLAN table isn’t used on this port',
  fallback: 'VLAN table used; frames for VLANs not in it are forwarded as usual',
  check: 'Frames for VLANs not in the table are dropped',
  secure: 'Frames are dropped unless their VLAN is in the table and this port is a member',
};
const HEADER_HELP: Record<string, string> = {
  'leave-as-is': 'Frames leave as they arrived',
  'add-if-missing': 'Untagged frames get a tag on the way out (a trunk)',
  'always-strip': 'Tags are removed on the way out (an access port)',
};
const MODES = ['disabled', 'fallback', 'check', 'secure'];
const HEADERS = ['leave-as-is', 'add-if-missing', 'always-strip'];

type Entry = SwitchVlanView['vlans'][number];
type Port = SwitchVlanView['ports'][number];

function errText(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'That didn’t work';
}

/** Port checkboxes for a VLAN entry's member list. */
function PortPicker({ all, chosen, onChange }: { all: string[]; chosen: string[]; onChange: (p: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {all.map((p) => (
        <label key={p} className="flex items-center gap-1 font-mono text-xs text-gray-700 dark:text-slate-300">
          <input type="checkbox" checked={chosen.includes(p)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, p] : chosen.filter((x) => x !== p))} />
          {p}
        </label>
      ))}
    </div>
  );
}

/**
 * VLANs in the switch chip's own table (#278): older chips such as the
 * Atheros 8327 in a hAP ac² do VLANs here rather than with bridge VLAN
 * filtering, which on them moves switching to the CPU.
 *
 * Every edit requires Change Guard's auto-revert: the lockout model can't
 * simulate the switch chip, so it can't promise a change is safe. Where the
 * device can't arm a revert, the change is refused rather than run.
 */
export default function SwitchVlanCard({ view, deviceId }: { view: SwitchVlanView; deviceId: number }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const chip = view.switches.map((s) => s.type).filter(Boolean).join(', ');
  const allPorts = view.ports.map((p) => p.name);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; ports: string[]; disabled: boolean } | null>(null);
  const [adding, setAdding] = useState<{ vlan: string; ports: string[] } | null>(null);
  const [portEdits, setPortEdits] = useState<Record<string, Partial<Port>>>({});

  const done = (r: { data?: { message?: string; guard?: GuardResult } }) => {
    const g = guardOutcomeMessage(r.data?.guard);
    setNote(g ? { ok: g.tone === 'ok', text: g.text } : { ok: true, text: r.data?.message || 'Saved' });
    void qc.invalidateQueries({ queryKey: ['switch-vlans', deviceId] });
  };
  const failed = (e: unknown) => setNote({ ok: false, text: errText(e) });

  const add = useMutation({
    mutationFn: (a: { vlan: number; ports: string[] }) =>
      devicesApi.addSwitchVlan(deviceId, { switch: view.switches[0]?.name || 'switch1', vlan_id: a.vlan, ports: a.ports }),
    onSuccess: (r) => { setAdding(null); done(r); }, onError: failed,
  });
  const update = useMutation({
    mutationFn: (e: { id: string; ports: string[]; disabled: boolean }) =>
      devicesApi.updateSwitchVlan(deviceId, e.id, { ports: e.ports, disabled: e.disabled }),
    onSuccess: (r) => { setEditing(null); done(r); }, onError: failed,
  });
  const remove = useMutation({
    mutationFn: (id: string) => devicesApi.removeSwitchVlan(deviceId, id),
    onSuccess: done, onError: failed,
  });
  const setPort = useMutation({
    mutationFn: ({ name, edit }: { name: string; edit: Partial<Port> }) =>
      devicesApi.setSwitchPortVlan(deviceId, name, {
        ...(edit.vlanMode !== undefined ? { vlan_mode: edit.vlanMode } : {}),
        ...(edit.vlanHeader !== undefined ? { vlan_header: edit.vlanHeader } : {}),
        ...(edit.defaultVlanId !== undefined ? { default_vlan_id: edit.defaultVlanId } : {}),
      }),
    onSuccess: (r, v) => { setPortEdits((p) => { const n = { ...p }; delete n[v.name]; return n; }); done(r); },
    onError: failed,
  });
  const busy = add.isPending || update.isPending || remove.isPending || setPort.isPending;
  const portEdit = (name: string, patch: Partial<Port>, row: Port) => setPortEdits((p) => {
    const next = { ...(p[name] ?? {}), ...patch };
    // Drop fields put back to what the device has, so Save only appears for a real change.
    for (const k of Object.keys(next) as (keyof Port)[]) if (next[k] === row[k]) delete next[k];
    const n = { ...p };
    if (Object.keys(next).length) n[name] = next; else delete n[name];
    return n;
  });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Cpu className="w-4 h-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Switch chip VLANs</h3>
        <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium',
          view.inUse ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300')}>
          {view.inUse ? 'In use' : 'Not set up'}
        </span>
        {chip && <span className="text-xs text-gray-400 dark:text-slate-500 font-mono">{chip}</span>}
        {busy && <RefreshCw className="w-3.5 h-3.5 animate-spin text-gray-400 ml-auto" />}
      </div>
      <p className="text-xs text-gray-500 dark:text-slate-400">
        This device&apos;s switch chip keeps VLANs in its own table (Switch, VLAN in WinBox) rather than with
        bridge VLAN filtering, which on this chip moves switching to the CPU.
        {canWrite && ' Every change here runs with Change Guard’s auto-revert required, since these settings can cut the device off: if it stops answering, it restores its previous configuration and restarts.'}
      </p>

      {note && (
        <div className={clsx('flex gap-2 p-2.5 rounded-lg border text-xs',
          note.ok ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300')}>
          <p className="flex-1">{note.text}</p>
          <button type="button" onClick={() => setNote(null)} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {view.filteringBridges.length > 0 && (
        <div className="flex gap-2 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <p>
            VLAN filtering is on for {view.filteringBridges.join(', ')}. On this switch chip that bridge&apos;s
            traffic is switched by the CPU, not the chip.
          </p>
        </div>
      )}

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
            <th className="py-1.5 pr-3 font-medium w-28">VLAN</th>
            <th className="py-1.5 pr-3 font-medium">Ports</th>
            <th className="py-1.5 pr-3 font-medium w-20">Switch</th>
            {canWrite && <th className="py-1.5 w-16" />}
          </tr>
        </thead>
        <tbody>
          {view.vlans.length === 0 && !adding && (
            <tr><td colSpan={4} className="py-2 text-gray-400 dark:text-slate-500">The switch VLAN table is empty.</td></tr>
          )}
          {view.vlans.map((v: Entry) => editing?.id === v.id ? (
            <tr key={v.id} className="border-b border-gray-100 dark:border-slate-800 bg-blue-50/50 dark:bg-slate-700/40">
              <td className="py-2 pr-3 font-mono text-gray-900 dark:text-white align-top">
                {v.vlanId}
                <label className="flex items-center gap-1 mt-1 font-sans text-gray-600 dark:text-slate-300">
                  <input type="checkbox" checked={!editing.disabled} onChange={(e) => setEditing({ ...editing, disabled: !e.target.checked })} /> enabled
                </label>
              </td>
              <td className="py-2 pr-3"><PortPicker all={allPorts} chosen={editing.ports} onChange={(ports) => setEditing({ ...editing, ports })} /></td>
              <td className="py-2 pr-3 font-mono text-gray-500 dark:text-slate-400 align-top">{v.switch}</td>
              <td className="py-2 align-top">
                <div className="flex gap-1">
                  <button type="button" title="Save" disabled={busy || editing.ports.length === 0}
                    onClick={() => update.mutate(editing)} className="p-1 text-green-600 disabled:opacity-40"><Check className="w-3.5 h-3.5" /></button>
                  <button type="button" title="Cancel" onClick={() => setEditing(null)} className="p-1 text-gray-400"><X className="w-3.5 h-3.5" /></button>
                </div>
              </td>
            </tr>
          ) : (
            <tr key={v.id || `${v.switch}-${v.vlanId}`} className={clsx('border-b border-gray-100 dark:border-slate-800', v.disabled && 'opacity-50')}>
              <td className="py-1.5 pr-3 font-mono text-gray-900 dark:text-white">{v.vlanId}{v.disabled && <span className="ml-1 text-gray-400">(disabled)</span>}</td>
              <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-300">{v.ports.join(', ') || '—'}</td>
              <td className="py-1.5 pr-3 font-mono text-gray-500 dark:text-slate-400">{v.switch}</td>
              {canWrite && (
                <td className="py-1.5">
                  <div className="flex gap-1">
                    <button type="button" title="Edit" disabled={busy}
                      onClick={() => { setNote(null); setAdding(null); setEditing({ id: v.id, ports: v.ports, disabled: v.disabled }); }}
                      className="p-1 text-gray-400 hover:text-blue-500"><Pencil className="w-3.5 h-3.5" /></button>
                    <button type="button" title="Remove" disabled={busy}
                      onClick={() => { if (confirm(`Remove switch VLAN ${v.vlanId}? Change Guard's auto-revert covers it.`)) { setNote(null); remove.mutate(v.id); } }}
                      className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </td>
              )}
            </tr>
          ))}
          {adding && (
            <tr className="border-b border-gray-100 dark:border-slate-800 bg-blue-50/50 dark:bg-slate-700/40">
              <td className="py-2 pr-3 align-top">
                <input className="input py-1 text-xs font-mono w-20" placeholder="VLAN" value={adding.vlan} aria-label="VLAN ID"
                  onChange={(e) => setAdding({ ...adding, vlan: e.target.value.replace(/[^0-9]/g, '') })} />
              </td>
              <td className="py-2 pr-3"><PortPicker all={allPorts} chosen={adding.ports} onChange={(ports) => setAdding({ ...adding, ports })} /></td>
              <td className="py-2 pr-3 font-mono text-gray-500 dark:text-slate-400 align-top">{view.switches[0]?.name}</td>
              <td className="py-2 align-top">
                <div className="flex gap-1">
                  <button type="button" title="Add" disabled={busy || !adding.vlan || Number(adding.vlan) > 4095 || adding.ports.length === 0}
                    onClick={() => add.mutate({ vlan: Number(adding.vlan), ports: adding.ports })} className="p-1 text-green-600 disabled:opacity-40"><Check className="w-3.5 h-3.5" /></button>
                  <button type="button" title="Cancel" onClick={() => setAdding(null)} className="p-1 text-gray-400"><X className="w-3.5 h-3.5" /></button>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {canWrite && !adding && (
        <button type="button" disabled={busy}
          onClick={() => { setNote(null); setEditing(null); setAdding({ vlan: '', ports: allPorts.filter((p) => p.endsWith('-cpu')) }); }}
          className="btn-secondary text-xs py-1 flex items-center gap-1.5"><Plus className="w-3 h-3" /> Add switch VLAN</button>
      )}

      {view.ports.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
              <th className="py-1.5 pr-3 font-medium">Port</th>
              <th className="py-1.5 pr-3 font-medium">VLAN mode</th>
              <th className="py-1.5 pr-3 font-medium">VLAN header</th>
              <th className="py-1.5 pr-3 font-medium">Default VLAN</th>
              {canWrite && <th className="py-1.5 w-16" />}
            </tr>
          </thead>
          <tbody>
            {view.ports.map((p) => {
              const e = portEdits[p.name];
              const cur = { ...p, ...(e ?? {}) };
              return (
                <tr key={`${p.switch}-${p.name}`} className="border-b border-gray-100 dark:border-slate-800">
                  <td className="py-1.5 pr-3 font-mono text-gray-900 dark:text-white">{p.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-300" title={MODE_HELP[cur.vlanMode]}>
                    {canWrite ? (
                      <select className="input py-0.5 text-xs font-mono w-28" value={cur.vlanMode} aria-label={`VLAN mode for ${p.name}`}
                        onChange={(ev) => portEdit(p.name, { vlanMode: ev.target.value }, p)}>
                        {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (p.vlanMode || '—')}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-300" title={HEADER_HELP[cur.vlanHeader]}>
                    {canWrite ? (
                      <select className="input py-0.5 text-xs font-mono w-36" value={cur.vlanHeader} aria-label={`VLAN header for ${p.name}`}
                        onChange={(ev) => portEdit(p.name, { vlanHeader: ev.target.value }, p)}>
                        {HEADERS.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    ) : (p.vlanHeader || '—')}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-300">
                    {canWrite ? (
                      <input className="input py-0.5 text-xs font-mono w-20" value={cur.defaultVlanId} aria-label={`Default VLAN for ${p.name}`}
                        onChange={(ev) => portEdit(p.name, { defaultVlanId: ev.target.value.trim() }, p)} placeholder="auto" />
                    ) : (p.defaultVlanId || '—')}
                  </td>
                  {canWrite && (
                    <td className="py-1.5">
                      {e && (
                        <div className="flex gap-1">
                          <button type="button" title="Save" disabled={busy}
                            onClick={() => { setNote(null); setPort.mutate({ name: p.name, edit: e }); }}
                            className="p-1 text-green-600 disabled:opacity-40"><Check className="w-3.5 h-3.5" /></button>
                          <button type="button" title="Undo" onClick={() => setPortEdits((x) => { const n = { ...x }; delete n[p.name]; return n; })}
                            className="p-1 text-gray-400"><X className="w-3.5 h-3.5" /></button>
                        </div>
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
  );
}
