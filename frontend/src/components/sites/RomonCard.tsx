import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Radar, Pencil, Trash2, X, Check, RefreshCw } from 'lucide-react';
import { romonApi, siteGroupsApi, type RomonSettingRow } from '../../services/api';
import type { Site } from '../../store/siteStore';
import { useAuthStore } from '../../store/authStore';

type Target = { scope: RomonSettingRow['scope']; id: number | null; name: string };

/**
 * RoMON per site or group, with a fleet default (#311): keep it on, and the
 * secret devices use. The security checks flag devices that differ, with a
 * fix; nothing is applied from here. Secrets are write-only: once saved they
 * show as "set", never their value.
 */
export default function RomonCard({ sites }: { sites: Site[] }) {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const fleetAdmin = user?.role === 'admin' && !user?.siteRoles;
  const mayEdit = (t: Target) => fleetAdmin || (t.scope === 'site' && t.id != null && user?.siteRoles?.[String(t.id)] === 'admin');
  const { data: rows = [] } = useQuery({ queryKey: ['romon-settings'], queryFn: () => romonApi.list().then((r) => r.data) });
  const { data: groups = [] } = useQuery({ queryKey: ['site-groups'], queryFn: () => siteGroupsApi.list().then((r) => r.data), enabled: fleetAdmin });
  const [editing, setEditing] = useState<Target | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [secret, setSecret] = useState('');
  const [secretMode, setSecretMode] = useState<'keep' | 'set' | 'remove'>('keep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const rowFor = (t: { scope: RomonSettingRow['scope']; id: number | null }) => rows.find((r) => r.scope === t.scope && r.id === t.id);
  const describe = (r?: RomonSettingRow) => !r ? 'Not set' : `${r.enabled ? 'On' : 'Off'}${r.has_secret ? ', with a secret' : ', no secret set'}`;

  const fleetTarget: Target = { scope: 'fleet', id: null, name: 'Fleet default' };
  const targets: Target[] = [
    fleetTarget,
    ...groups.map((g) => ({ scope: 'group' as const, id: g.id, name: g.name })),
    ...rows.filter((r) => r.scope === 'site').map((r) => ({ scope: 'site' as const, id: r.id, name: r.name ?? `Site ${r.id}` })),
  ];
  const siteChoices = sites.filter((s) => !rowFor({ scope: 'site', id: s.id }) && mayEdit({ scope: 'site', id: s.id, name: s.name }));

  function start(t: Target) {
    const r = rowFor(t);
    setEditing(t); setEnabled(r?.enabled ?? true); setSecret(''); setSecretMode(r?.has_secret ? 'keep' : 'set'); setError('');
  }

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['romon-settings'] }),
    qc.invalidateQueries({ queryKey: ['security-fleet'] }),
  ]);
  const fail = (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save');

  async function save() {
    if (!editing) return;
    if (secretMode === 'set' && secret.includes(',')) { setError('The secret can’t contain a comma.'); return; }
    setBusy(true); setError('');
    try {
      await romonApi.save({
        scope: editing.scope, id: editing.id, enabled,
        ...(secretMode === 'set' && secret ? { secret } : secretMode === 'remove' || (secretMode === 'set' && !secret) ? { secret: null } : {}),
      });
      await refresh();
      setEditing(null);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function clear(t: Target) {
    if (!window.confirm(`Remove the RoMON setting for ${t.name}? ${t.scope === 'fleet' ? 'Devices without a site or group setting will no longer be checked.' : 'Its devices fall back to the next setting up.'}`)) return;
    try { await romonApi.remove(t.scope, t.id); await refresh(); } catch (e) { fail(e); }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <Radar className="w-4 h-4" style={{ color: 'var(--ink-3)' }} />
        <h3 className="text-sm font-semibold flex-1" style={{ color: 'var(--ink)' }}>RoMON</h3>
      </div>
      <p className="px-4 pt-3 text-sm" style={{ color: 'var(--ink-3)' }}>
        Keep RoMON on, with the secret its RoMON network uses, per site or group (a site&apos;s setting wins over its group&apos;s, and both over
        the fleet default). The Security page flags devices that differ and can apply the setting; nothing changes on its own.
      </p>
      {error && <p className="px-4 pt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {editing && (
        <div className="px-4 py-3 space-y-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>{editing.name}</div>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--ink-2)' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Keep RoMON on
          </label>
          <div className="space-y-1.5">
            <div className="text-xs" style={{ color: 'var(--ink-3)' }}>Secret</div>
            {rowFor(editing)?.has_secret && (
              <div className="flex gap-3 text-sm" style={{ color: 'var(--ink-2)' }}>
                <label className="flex items-center gap-1.5"><input type="radio" checked={secretMode === 'keep'} onChange={() => setSecretMode('keep')} /> Keep the saved one</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={secretMode === 'set'} onChange={() => setSecretMode('set')} /> Change it</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={secretMode === 'remove'} onChange={() => setSecretMode('remove')} /> No secret</label>
              </div>
            )}
            {secretMode === 'set' && (
              <input type="password" autoComplete="new-password" className="input max-w-sm" value={secret} onChange={(e) => setSecret(e.target.value)}
                placeholder="Leave blank for no secret" aria-label="RoMON secret" />
            )}
            <p className="text-xs" style={{ color: 'var(--ink-4)' }}>
              Stored encrypted and never shown again. With no secret, devices&apos; own secrets are left as they are.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void save()} disabled={busy} className="btn-primary text-sm flex items-center gap-1.5">
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}{busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditing(null)} className="btn-secondary text-sm flex items-center gap-1.5"><X className="w-4 h-4" />Cancel</button>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <tbody>
          {targets.filter((t) => t.scope !== 'fleet' || fleetAdmin || rowFor(t)).map((t) => (
            <tr key={`${t.scope}:${t.id ?? 0}`} className="border-t" style={{ borderColor: 'var(--line-soft)' }}>
              <td className="px-4 py-2.5" style={{ color: 'var(--ink)' }}>
                {t.name}
                <span className="text-xs ml-1.5" style={{ color: 'var(--ink-4)' }}>{t.scope === 'fleet' ? '' : t.scope}</span>
              </td>
              <td className="px-4 py-2.5" style={{ color: 'var(--ink-3)' }}>{describe(rowFor(t))}</td>
              <td className="px-4 py-2.5 w-20">
                {mayEdit(t) && (
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => start(t)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                    {rowFor(t) && (
                      <button onClick={() => void clear(t)} className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-gray-400 hover:text-red-500" title="Remove this setting"><Trash2 className="w-3.5 h-3.5" /></button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {siteChoices.length > 0 && (
        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
          <select className="input max-w-xs text-sm" value="" aria-label="Set RoMON for a site"
            onChange={(e) => { const s = sites.find((x) => x.id === Number(e.target.value)); if (s) start({ scope: 'site', id: s.id, name: s.name }); }}>
            <option value="">Set a site&apos;s own RoMON setting…</option>
            {siteChoices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
