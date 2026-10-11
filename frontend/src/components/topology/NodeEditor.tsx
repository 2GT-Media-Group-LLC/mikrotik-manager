import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { topologyApi } from '../../services/api';
import type { TopologyNode } from '../../types';
import { NODE_KINDS } from './nodes';

// ─── Node editor ─────────────────────────────────────────────────────────────

export default function NodeEditor({ node, onClose, onSaved }: { node: TopologyNode | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(node?.name ?? '');
  const [kind, setKind] = useState(node?.kind ?? 'modem');
  const [address, setAddress] = useState(node?.address ?? '');
  const [notes, setNotes] = useState(node?.notes ?? '');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body = { name, kind, address: address || null, notes: notes || null };
      return node ? topologyApi.updateNode(node.id, body) : topologyApi.createNode(body);
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Couldn’t save'),
  });
  const del = useMutation({
    mutationFn: () => topologyApi.deleteNode(node!.id),
    onSuccess: () => { onSaved(); onClose(); },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-md mx-4 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">{node ? 'Edit node' : 'Add a node'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Something on your network the manager doesn&apos;t manage: the ISP modem, a server, an unmanaged switch.
          Connect it to a device with Connect Mode.
        </p>
        <div>
          <label className="label">Name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ISP fibre ONT" autoFocus maxLength={100} />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {NODE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Address (optional)</label>
          <input className="input font-mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.254" maxLength={255} />
        </div>
        <div>
          <label className="label">Notes (optional)</label>
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex items-center gap-2 pt-1">
          {node && (
            <button className="text-sm text-red-600 hover:underline mr-auto" disabled={del.isPending}
              onClick={() => { if (window.confirm(`Delete ${node.name} and its links?`)) del.mutate(); }}>
              Delete node
            </button>
          )}
          <button className="btn-secondary text-sm ml-auto" onClick={onClose}>Cancel</button>
          <button className="btn-primary text-sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            {node ? 'Save' : 'Add node'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page component ──────────────────────────────────────────────────────

