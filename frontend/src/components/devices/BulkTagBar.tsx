import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag as TagIcon, X, Loader2, KeyRound, Building2 } from 'lucide-react';
import { tagsApi, sitesApi } from '../../services/api';
import type { Device, Tag } from '../../types';

/**
 * Add or remove a tag on every selected device at once (#161).
 *
 * Tags were settable one device at a time, which made them impractical as the
 * way to group a fleet for rollouts, channels and bulk commands.
 */
export default function BulkTagBar({ devices, tags, onClear, onChangeLogin }: {
  devices: Device[];
  tags: Tag[];
  onClear: () => void;
  /** Change the login the manager uses for the selected devices (#259). */
  onChangeLogin?: () => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = useMutation({
    mutationFn: async ({ tag, action }: { tag: Tag; action: 'add' | 'remove' }) => {
      const r = await tagsApi.assignDevices(tag.id, devices.map((d) => d.id), action);
      return { tag, action, changed: (r.data as { changed?: number })?.changed };
    },
    onSuccess: ({ tag, action, changed }) => {
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['device-tags'] });
      const n = changed ?? devices.length;
      setNote({
        ok: true,
        text: action === 'add'
          ? `Added "${tag.name}" to ${n} device${n === 1 ? '' : 's'}${n < devices.length ? ` (${devices.length - n} already had it)` : ''}.`
          : `Removed "${tag.name}" from ${n} device${n === 1 ? '' : 's'}.`,
      });
    },
    onError: () => setNote({ ok: false, text: 'Could not update tags.' }),
  });

  // Move every selected device into one site (#306). Changes who can reach
  // them, so it asks first; the server checks the account may.
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data), staleTime: 60_000 });
  const move = useMutation({
    mutationFn: async (site: { id: number; name: string }) => {
      const r = await sitesApi.moveDevices(site.id, devices.map((d) => d.id));
      return { site, moved: r.data.moved };
    },
    onSuccess: ({ site, moved }) => {
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['sites'] });
      qc.invalidateQueries({ queryKey: ['site-groups'] });
      setNote({ ok: true, text: `Moved ${moved} device${moved === 1 ? '' : 's'} to ${site.name}.` });
    },
    onError: (e: unknown) => setNote({ ok: false, text: (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not move the devices.' }),
  });
  const pickSite = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const site = sites.find((s) => s.id === Number(e.target.value));
    e.target.value = '';
    if (!site) return;
    const n = devices.length;
    if (!window.confirm(`Move ${n} device${n === 1 ? '' : 's'} to ${site.name}? Their history moves with them, and who can see them follows the site.`)) return;
    setNote(null);
    move.mutate(site);
  };

  const pick = (action: 'add' | 'remove') => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const tag = tags.find((t) => t.id === Number(e.target.value));
    e.target.value = '';
    if (tag) { setNote(null); apply.mutate({ tag, action }); }
  };

  const selectStyle = { background: 'var(--surface)', color: 'var(--ink-2)', border: '1px solid var(--line)' };

  return (
    <div
      className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]"
      style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}
    >
      <span className="font-medium" style={{ color: 'var(--ink)' }}>
        {devices.length} selected
      </span>
      {tags.length === 0 ? (
        <span style={{ color: 'var(--ink-3)' }}>No tags yet. Create one under Settings → Tags.</span>
      ) : (
        <>
          <label className="flex items-center gap-1.5" style={{ color: 'var(--ink-3)' }}>
            <TagIcon className="w-3.5 h-3.5" />
            <select className="text-[12px] px-2 py-1 rounded" style={selectStyle} defaultValue="" onChange={pick('add')} disabled={apply.isPending}>
              <option value="" disabled>Add tag…</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <select className="text-[12px] px-2 py-1 rounded" style={selectStyle} defaultValue="" onChange={pick('remove')} disabled={apply.isPending}>
            <option value="" disabled>Remove tag…</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </>
      )}
      {sites.length > 1 && (
        <label className="flex items-center gap-1.5" style={{ color: 'var(--ink-3)' }}>
          <Building2 className="w-3.5 h-3.5" />
          <select className="text-[12px] px-2 py-1 rounded" style={selectStyle} defaultValue="" onChange={pickSite} disabled={move.isPending} aria-label="Move to site">
            <option value="" disabled>Move to site…</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.group_name ? ` (${s.group_name})` : ''}</option>)}
          </select>
        </label>
      )}
      {onChangeLogin && (
        <button onClick={onChangeLogin} className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded" style={selectStyle}>
          <KeyRound className="w-3.5 h-3.5" /> Change login…
        </button>
      )}
      {(apply.isPending || move.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--ink-3)' }} />}
      {note && (
        <span style={{ color: note.ok ? 'var(--ok, #16a34a)' : '#dc2626' }}>{note.text}</span>
      )}
      <button onClick={onClear} className="ml-auto flex items-center gap-1 text-[12px]" style={{ color: 'var(--ink-3)' }}>
        <X className="w-3.5 h-3.5" /> Clear selection
      </button>
    </div>
  );
}
