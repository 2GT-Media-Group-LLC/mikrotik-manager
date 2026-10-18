import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Pencil, Plus, Trash2, Check, X, RefreshCw } from 'lucide-react';
import { siteGroupsApi } from '../../services/api';
import type { Site } from '../../store/siteStore';

/**
 * Groups of sites (#306): one per customer. Choosing one in the site switcher
 * narrows every page to its sites, and access can be given per group under
 * Users & Roles. A site is put in a group here or when editing the site.
 * Managed by fleet-wide accounts.
 */
export default function GroupsCard({ sites, canManage, onOpen }: {
  sites: Site[];
  canManage: boolean;
  onOpen: (groupId: number) => void;
}) {
  const qc = useQueryClient();
  const { data: groups = [] } = useQuery({
    queryKey: ['site-groups'],
    queryFn: () => siteGroupsApi.list().then((r) => r.data),
  });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['site-groups'] }),
    qc.invalidateQueries({ queryKey: ['sites'] }),
  ]);
  const fail = (e: unknown, fallback: string) =>
    setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback);

  function start(id: number | 'new') {
    const g = id === 'new' ? null : groups.find((x) => x.id === id) ?? null;
    setEditing(id);
    setName(g?.name ?? '');
    setMembers(new Set(g ? sites.filter((s) => s.group_id === g.id).map((s) => s.id) : []));
    setError('');
  }

  async function save() {
    if (!name.trim()) { setError('Group name is required'); return; }
    setBusy(true); setError('');
    try {
      const payload = { name: name.trim(), site_ids: [...members] };
      if (editing === 'new') await siteGroupsApi.create(payload);
      else if (editing != null) await siteGroupsApi.update(editing, payload);
      await refresh();
      setEditing(null);
    } catch (e) { fail(e, 'Could not save the group'); } finally { setBusy(false); }
  }

  async function remove(id: number, groupName: string) {
    if (!window.confirm(`Delete the group “${groupName}”? Its sites and devices stay; only the grouping goes, and any access given through it.`)) return;
    setError('');
    try { await siteGroupsApi.remove(id); await refresh(); } catch (e) { fail(e, 'Could not delete the group'); }
  }

  if (!canManage && groups.length === 0) return null;
  const otherGroup = (s: Site) => s.group_id != null && s.group_id !== editing ? s.group_name : null;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <FolderOpen className="w-4 h-4" style={{ color: 'var(--ink-3)' }} />
        <h3 className="text-sm font-semibold flex-1" style={{ color: 'var(--ink)' }}>Groups</h3>
        {canManage && editing == null && (
          <button onClick={() => start('new')} className="flex items-center gap-1 text-sm" style={{ color: 'var(--accent)' }}>
            <Plus className="w-3.5 h-3.5" /> New group
          </button>
        )}
      </div>
      {groups.length === 0 && editing == null && (
        <p className="px-4 py-3 text-sm" style={{ color: 'var(--ink-3)' }}>
          A group is a set of sites belonging to one customer. Choose it in the site switcher to see just that customer, and give
          people access to it under Users &amp; Roles.
        </p>
      )}
      {error && <p className="px-4 pt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {editing != null && (
        <div className="px-4 py-3 space-y-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <input autoFocus className="input max-w-sm" placeholder="Group name, e.g. the customer" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(null); }} />
          <div>
            <div className="text-xs mb-1.5" style={{ color: 'var(--ink-3)' }}>Sites in this group</div>
            <div className="grid gap-1 max-h-64 overflow-y-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
              {sites.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer min-w-0">
                  <input type="checkbox" checked={members.has(s.id)} onChange={(e) => setMembers((m) => {
                    const n = new Set(m); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n;
                  })} />
                  <span className="truncate" style={{ color: 'var(--ink)' }}>{s.name}</span>
                  {otherGroup(s) && <span className="text-[11px] truncate" style={{ color: 'var(--ink-4)' }} title="Ticking moves it here">in {otherGroup(s)}</span>}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void save()} disabled={busy} className="btn-primary flex items-center gap-1.5 text-sm">
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}{busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditing(null)} className="btn-secondary text-sm flex items-center gap-1.5"><X className="w-4 h-4" />Cancel</button>
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {groups.map((g) => (
              <tr key={g.id} className="border-b last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50"
                style={{ borderColor: 'var(--line-soft)' }} onClick={() => onOpen(g.id)} title="Show only this group">
                <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--ink)' }}>{g.name}</td>
                <td className="px-4 py-2.5" style={{ color: 'var(--ink-3)' }}>
                  {g.site_ids.length} site{g.site_ids.length === 1 ? '' : 's'} · {g.device_count} device{g.device_count === 1 ? '' : 's'}
                  {g.device_count - g.online_count > 0 && <span className="text-red-500"> · {g.device_count - g.online_count} offline</span>}
                </td>
                {canManage && (
                  <td className="px-4 py-2.5 w-20" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => start(g.id)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400" title="Rename, or choose its sites">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => void remove(g.id, g.name)} className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-gray-400 hover:text-red-500" title="Delete">
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
  );
}
