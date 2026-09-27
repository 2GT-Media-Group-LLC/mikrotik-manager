import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Play, Pencil, Copy, Trash2, Search, X } from 'lucide-react';
import { commandTemplatesApi, type CommandTemplate } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';

/**
 * The template library (#163).
 *
 * One place for the reusable snippets every admin collects: firewall rules, LTE
 * settings, NTP and DNS defaults. Config Templates were merged into this and
 * converted automatically. Running a template opens it in Bulk Commands, so it
 * goes through waves, halt-on-failure and Change Guard like any command.
 */

type Draft = { id: number | null; name: string; description: string; command: string };
const EMPTY: Draft = { id: null, name: '', description: '', command: '' };

export default function TemplatesPage() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['command-templates'],
    queryFn: () => commandTemplatesApi.list().then((r) => r.data),
  });

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) =>
      [t.name, t.description ?? '', t.command].some((f) => f.toLowerCase().includes(q)));
  }, [templates, search]);

  const errMsg = (e: unknown) =>
    (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not save the template';

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = { name: d.name, description: d.description, command: d.command };
      return d.id ? commandTemplatesApi.update(d.id, body) : commandTemplatesApi.create(body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['command-templates'] }); setDraft(null); setError(''); },
    onError: (e) => setError(errMsg(e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => commandTemplatesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['command-templates'] }),
  });

  const edit = (t: CommandTemplate) => { setError(''); setDraft({ id: t.id, name: t.name, description: t.description ?? '', command: t.command }); };
  const duplicate = (t: CommandTemplate) => { setError(''); setDraft({ id: null, name: `${t.name} (copy)`, description: t.description ?? '', command: t.command }); };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-500" /> Templates
          </h1>
          <p className="text-sm text-gray-600 dark:text-slate-300 mt-1 max-w-2xl">
            Saved RouterOS commands you run more than once. <strong>Run</strong> opens a template in
            Bulk Commands, where you pick devices or tags and it runs in waves, stopping on failure.
          </p>
        </div>
        {canWrite && !draft && (
          <button className="btn-primary flex items-center gap-1.5 text-sm" onClick={() => { setError(''); setDraft({ ...EMPTY }); }}>
            <Plus className="w-4 h-4" /> New template
          </button>
        )}
      </div>

      {draft && (
        <div className="card p-5 space-y-3">
          <h2 className="font-semibold text-gray-900 dark:text-white">{draft.id ? 'Edit template' : 'New template'}</h2>
          <input className="input w-full" placeholder="Name, e.g. LTE failover defaults" value={draft.name}
                 onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
          <input className="input w-full" placeholder="What it's for (optional)" value={draft.description}
                 onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <textarea className="input w-full font-mono text-sm" rows={8} spellCheck={false}
                    placeholder={'/interface lte set [ find default-name=lte1 ] allow-roaming=yes\n/interface list member add interface=lte1 list=WAN'}
                    value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
          <p className="text-xs text-gray-500 dark:text-slate-400">One command per line; they run in order over SSH.</p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button className="btn-primary text-sm" disabled={!draft.name.trim() || !draft.command.trim() || save.isPending}
                    onClick={() => save.mutate(draft)}>
              {draft.id ? 'Save changes' : 'Save template'}
            </button>
            <button className="btn-secondary text-sm" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input className="input w-full pl-9" placeholder="Search names, descriptions and commands"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && (
          <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" onClick={() => setSearch('')} aria-label="Clear search">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gray-500 dark:text-slate-400">
          {templates.length === 0
            ? 'No templates yet. Save one here, or from Bulk Commands with "Save as template".'
            : 'No templates match that search.'}
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((t) => (
            <div key={t.id} className="card p-4 space-y-2">
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900 dark:text-white">{t.name}</span>
                    {t.created_by === 'converted' && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                        from Config Templates
                      </span>
                    )}
                  </div>
                  {t.description && <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">{t.description}</p>}
                </div>
                <div className="flex items-center gap-1.5">
                  <Link to={`/commands?template=${t.id}`} className="btn-primary text-xs py-1 flex items-center gap-1">
                    <Play className="w-3.5 h-3.5" /> Run
                  </Link>
                  {canWrite && (
                    <>
                      <button className="btn-secondary text-xs py-1 flex items-center gap-1" onClick={() => edit(t)}>
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                      <button className="btn-secondary text-xs py-1 flex items-center gap-1" onClick={() => duplicate(t)} title="Duplicate">
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button className="text-red-600 p-1" title="Delete" disabled={remove.isPending}
                              onClick={() => { if (confirm(`Delete the template "${t.name}"?`)) remove.mutate(t.id); }}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-900/60 rounded p-2.5 overflow-x-auto whitespace-pre text-gray-700 dark:text-slate-300 max-h-40">
                {t.command}
              </pre>
              <div className="text-[11px] text-gray-400">
                Updated {new Date(t.updated_at).toLocaleString()}
                {t.created_by && t.created_by !== 'converted' ? ` · by ${t.created_by}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
