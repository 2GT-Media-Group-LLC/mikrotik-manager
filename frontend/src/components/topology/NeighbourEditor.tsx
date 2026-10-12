import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { topologyApi } from '../../services/api';
import { NODE_KINDS, capsLabel } from './nodes';

/**
 * Say what a neighbour discovery found really is (#260): a computer it took
 * for a switch, or a name more useful than the one it announces. Discovery
 * keeps finding it; this only changes how it's shown.
 */
export default function NeighbourEditor({ neighbour, onClose, onSaved }: {
  neighbour: { id: string; name: string; discoveredName?: string; caps?: string; overrideKind?: string | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const discovered = neighbour.discoveredName ?? neighbour.name;
  const [name, setName] = useState(neighbour.discoveredName ? neighbour.name : '');
  const [kind, setKind] = useState(neighbour.overrideKind ?? '');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (body: { name: string | null; kind: string | null }) => topologyApi.setNeighbour(neighbour.id, body),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Couldn’t save'),
  });
  const auto = capsLabel(neighbour.caps);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-md mx-4 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">Neighbour: {discovered}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Found by discovery, not managed. Change how it&apos;s shown on the map; discovery keeps finding it as before.
        </p>
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} placeholder={discovered} maxLength={255} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Automatic{auto ? ` (${auto})` : ''}</option>
            {NODE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex items-center justify-between pt-1">
          <button className="text-xs text-gray-500 hover:underline" onClick={() => save.mutate({ name: null, kind: null })}>Back to what discovery says</button>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate({ name: name.trim() || null, kind: kind || null })}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
