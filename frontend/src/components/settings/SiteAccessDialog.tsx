import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, RefreshCw, X } from 'lucide-react';
import { settingsApi, sitesApi } from '../../services/api';
import clsx from 'clsx';

export interface UserSiteRole { site_id: number; site_name: string; role: string }

type Choice = '' | 'viewer' | 'operator' | 'admin';

/**
 * Choose where an account has access (outside review P1-7): the whole fleet
 * under its role, or particular sites with a role in each. A site admin can
 * change devices and trust their certificates in that site; fleet settings,
 * users and SSO stay with fleet admins.
 */
export default function SiteAccessDialog({
  user, isSelf, onClose,
}: {
  user: { id: number; username: string; role: string; site_roles?: UserSiteRole[] };
  isSelf: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const initial = new Map((user.site_roles ?? []).map((r) => [r.site_id, r.role as Choice]));
  const [scoped, setScoped] = useState(initial.size > 0);
  const [roles, setRoles] = useState<Map<number, Choice>>(initial);
  const [error, setError] = useState('');

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data) });

  const save = useMutation({
    mutationFn: () => {
      const list = scoped
        ? [...roles.entries()].filter(([, r]) => r).map(([site_id, role]) => ({ site_id, role }))
        : [];
      return settingsApi.updateUser(user.id, { site_roles: list });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings-users'] }); onClose(); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not save'),
  });

  const chosen = [...roles.values()].filter(Boolean).length;
  const set = (siteId: number, role: Choice) => setRoles((m) => new Map(m).set(siteId, role));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 p-6 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2"><Globe className="w-4 h-4" /> Access for {user.username}</h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">Where this account can see and act, and with what role.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        {isSelf ? (
          <p className="text-sm text-gray-600 dark:text-slate-300">
            You can&apos;t limit your own account to particular sites: you would lose fleet administration.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" checked={!scoped} onChange={() => setScoped(false)} className="mt-1" />
                <span>
                  <span className="font-medium text-gray-900 dark:text-white">Whole fleet</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400">Every site, as <strong>{user.role}</strong> (the role set on the account).</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" checked={scoped} onChange={() => setScoped(true)} className="mt-1" />
                <span>
                  <span className="font-medium text-gray-900 dark:text-white">Specific sites</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400">
                    Only the sites below, with a role in each. Fleet settings, users, alerting and traffic analytics are not available.
                  </span>
                </span>
              </label>
            </div>

            {scoped && (
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 dark:text-slate-400">
                  <tr><th className="text-left font-medium py-1">Site</th><th className="text-right font-medium">Role</th></tr>
                </thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.id} className="border-t border-gray-100 dark:border-slate-700/50">
                      <td className="py-1.5 text-gray-900 dark:text-white">{s.name}</td>
                      <td className="py-1.5 text-right">
                        <select value={roles.get(s.id) ?? ''} onChange={(e) => set(s.id, e.target.value as Choice)}
                          className={clsx('input py-1 text-xs w-32', !roles.get(s.id) && 'text-gray-400')}>
                          <option value="">No access</option>
                          <option value="viewer">Viewer</option>
                          <option value="operator">Operator</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {scoped && chosen === 0 && (
              <p className="text-xs text-amber-600">Choose at least one site, or pick Whole fleet.</p>
            )}
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending || (scoped && chosen === 0)}
                className="btn-primary text-sm flex items-center gap-1.5">
                {save.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Save
              </button>
            </div>
            <p className="text-[11px] text-gray-400">Takes effect on the account&apos;s next request; it doesn&apos;t need to sign in again.</p>
          </>
        )}
      </div>
    </div>
  );
}
