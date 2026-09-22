import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, Check, X, Loader2 } from 'lucide-react';
import { tagsApi } from '../../services/api';
import type { Tag } from '../../types';

/**
 * One tag in Settings, editable in place.
 *
 * `PUT /tags/:id` and `tagsApi.update()` both existed and nothing called them,
 * which is the same shape assignment had before it was wired up: a tag could
 * be created and deleted but not renamed or recoloured (#149). Each row keeps
 * its own edit state so opening one does not disturb the others.
 */

interface Props {
  tag: Tag & { device_count?: number };
  canEdit: boolean;
  onDelete: (id: number) => void;
}

export default function TagRow({ tag, canEdit, onDelete }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);

  const save = useMutation({
    mutationFn: () => tagsApi.update(tag.id, { name: name.trim(), color }),
    onSuccess: () => {
      setEditing(false);
      // Tag chips render from the device payloads, so a rename or recolour has
      // to reach every list that shows them, not just this one.
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['device-tags'] });
    },
  });

  const start = () => { setName(tag.name); setColor(tag.color); setEditing(true); };
  const cancel = () => { setName(tag.name); setColor(tag.color); setEditing(false); };
  const count = tag.device_count ?? 0;
  const valid = name.trim().length > 0;

  if (editing) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'var(--surface-2)' }}>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="w-8 h-8 rounded cursor-pointer border border-gray-300 dark:border-slate-600 p-0.5 flex-shrink-0"
          aria-label="Tag colour"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) save.mutate();
            if (e.key === 'Escape') cancel();
          }}
          className="input flex-1 text-sm"
          autoFocus
          aria-label="Tag name"
        />
        <button
          onClick={() => save.mutate()}
          disabled={!valid || save.isPending}
          className="p-1.5 rounded text-green-600 hover:bg-green-500/10 disabled:opacity-40"
          title="Save"
        >
          {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        </button>
        <button onClick={cancel} className="p-1.5 rounded text-gray-400 hover:text-gray-600" title="Cancel">
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--surface-2)' }}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: tag.color }} />
        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{tag.name}</span>
        <span className="text-xs text-gray-400 dark:text-slate-500 flex-shrink-0">
          {count} device{count !== 1 ? 's' : ''}
        </span>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={start}
            className="p-1 rounded text-gray-400 hover:text-blue-500 transition-colors"
            title="Rename or recolour"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(tag.id)}
            className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
