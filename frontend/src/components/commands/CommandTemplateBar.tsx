import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookMarked, Save, Trash2, X } from 'lucide-react';
import { commandTemplatesApi, type CommandTemplate } from '../../services/api';

/**
 * Load a saved command into Bulk Commands, or save the current one (#163).
 *
 * Loading only fills the command box. Nothing runs until the operator picks
 * devices and presses Run, with the same waves and guards as a typed command.
 */
export default function CommandTemplateBar({ command, onLoad }: {
  command: string;
  onLoad: (command: string) => void;
}) {
  const qc = useQueryClient();
  const [loaded, setLoaded] = useState<CommandTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const { data: templates = [] } = useQuery({
    queryKey: ['command-templates'],
    queryFn: () => commandTemplatesApi.list().then((r) => r.data),
  });

  const done = () => { qc.invalidateQueries({ queryKey: ['command-templates'] }); setError(''); };
  const errMsg = (e: unknown) =>
    (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not save the template';

  const create = useMutation({
    mutationFn: () => commandTemplatesApi.create({ name, command, description }).then((r) => r.data),
    onSuccess: (t) => { done(); setLoaded(t); setSaving(false); },
    onError: (e) => setError(errMsg(e)),
  });
  const update = useMutation({
    mutationFn: () => commandTemplatesApi.update(loaded!.id, { command }).then((r) => r.data),
    onSuccess: (t) => { done(); setLoaded(t); },
    onError: (e) => setError(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: () => commandTemplatesApi.delete(loaded!.id),
    onSuccess: () => { done(); setLoaded(null); },
  });

  const changed = loaded && loaded.command !== command.trim();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <BookMarked className="w-4 h-4 text-gray-400" />
        <select
          className="input py-1 text-sm w-auto"
          value={loaded?.id ?? ''}
          onChange={(e) => {
            const t = templates.find((x) => x.id === Number(e.target.value)) ?? null;
            setLoaded(t);
            setSaving(false);
            if (t) onLoad(t.command);
          }}
        >
          <option value="">{templates.length ? 'Load a saved template…' : 'No saved templates yet'}</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {command.trim() && !saving && (
          <button type="button" className="btn-secondary text-xs py-1 flex items-center gap-1"
                  onClick={() => { setSaving(true); setName(''); setDescription(''); setError(''); }}>
            <Save className="w-3.5 h-3.5" /> Save as template
          </button>
        )}
        {loaded && changed && (
          <button type="button" className="btn-secondary text-xs py-1" disabled={update.isPending} onClick={() => update.mutate()}>
            Update &ldquo;{loaded.name}&rdquo;
          </button>
        )}
        {loaded && (
          <button type="button" className="text-xs text-red-600 flex items-center gap-1" disabled={remove.isPending}
                  onClick={() => { if (confirm(`Delete the template "${loaded.name}"?`)) remove.mutate(); }}>
            <Trash2 className="w-3.5 h-3.5" /> Delete template
          </button>
        )}
      </div>
      {loaded?.description && !saving && (
        <p className="text-xs text-gray-500 dark:text-slate-400">{loaded.description}</p>
      )}
      {saving && (
        <div className="flex flex-wrap items-center gap-2">
          <input className="input py-1 text-sm w-56" placeholder="Template name" value={name}
                 onChange={(e) => setName(e.target.value)} autoFocus />
          <input className="input py-1 text-sm flex-1 min-w-[12rem]" placeholder="What it's for (optional)"
                 value={description} onChange={(e) => setDescription(e.target.value)} />
          <button type="button" className="btn-primary text-xs py-1.5" disabled={!name.trim() || create.isPending}
                  onClick={() => create.mutate()}>Save</button>
          <button type="button" className="text-gray-400" onClick={() => setSaving(false)} aria-label="Cancel"><X className="w-4 h-4" /></button>
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
