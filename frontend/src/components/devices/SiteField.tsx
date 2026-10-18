import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sitesApi, siteGroupsApi } from '../../services/api';
import { useSiteStore } from '../../store/siteStore';
import { useAuthStore } from '../../store/authStore';

/** Where a device being added goes (#306): an existing site, or a new one by name. */
export interface SiteFieldValue {
  siteId: number | null;
  newSite: string | null;
  newGroup: string;
}

/** The payload fields for the choice: site_id, or site_name (+ group_name). */
export function siteFieldPayload(v: SiteFieldValue): { site_id?: number; site_name?: string; group_name?: string } {
  if (v.newSite != null) return { site_name: v.newSite.trim(), ...(v.newGroup.trim() ? { group_name: v.newGroup.trim() } : {}) };
  return v.siteId != null ? { site_id: v.siteId } : {};
}

/** Start with the site in view, or the default site. */
export function useDefaultSiteField(): SiteFieldValue {
  const current = useSiteStore((s) => s.currentSiteId);
  return { siteId: current, newSite: null, newGroup: '' };
}

/**
 * Site picker for Add Device: the sites the account may add to, and for a
 * fleet-wide account "New site…" with an optional group (made if it's new).
 * Hidden for a single-site install that can't make sites.
 */
export default function SiteField({ value, onChange }: { value: SiteFieldValue; onChange: (v: SiteFieldValue) => void }) {
  const siteRoles = useAuthStore((s) => s.user?.siteRoles);
  const fleet = !siteRoles;
  const { data: allSites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data), staleTime: 60_000 });
  const { data: groups = [] } = useQuery({
    queryKey: ['site-groups'], queryFn: () => siteGroupsApi.list().then((r) => r.data), staleTime: 60_000, enabled: fleet,
  });
  // An account limited to sites adds only where it's at least an operator.
  const sites = fleet ? allSites : allSites.filter((s) => ['admin', 'operator'].includes(siteRoles?.[String(s.id)] ?? ''));
  // With a group in view (#306), start on its first site; a limited account
  // with no site in view, on the first site it can add to.
  const groupId = useSiteStore((st) => st.currentGroupId);
  const inScope = groupId != null ? sites.filter((s) => s.group_id === groupId) : sites;
  const preferred = !fleet || groupId != null ? inScope[0]?.id ?? null : null;
  useEffect(() => {
    if (preferred != null && value.siteId == null && value.newSite == null) onChange({ ...value, siteId: preferred });
  }, [preferred, value, onChange]);
  if (!fleet && sites.length <= 1) return null;
  const shownId = value.siteId ?? allSites.find((s) => s.is_default)?.id ?? null;
  // One site: a single-network install never has to see the idea, but can
  // still start a new one here.
  if (fleet && allSites.length <= 1 && value.newSite == null) {
    return (
      <button type="button" className="text-xs underline" style={{ color: 'var(--ink-3)' }}
        onClick={() => onChange({ siteId: null, newSite: '', newGroup: '' })}>
        Add it to a new site…
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <label className="label">Site</label>
      <select
        className="input"
        value={value.newSite != null ? 'new' : shownId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'new') onChange({ siteId: null, newSite: '', newGroup: '' });
          else onChange({ siteId: v ? Number(v) : null, newSite: null, newGroup: '' });
        }}
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.group_name ? ` (${s.group_name})` : ''}</option>
        ))}
        {fleet && <option value="new">New site…</option>}
      </select>
      {value.newSite != null && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            autoFocus
            className="input"
            placeholder="New site name"
            value={value.newSite}
            onChange={(e) => onChange({ ...value, newSite: e.target.value })}
            aria-label="New site name"
          />
          <input
            className="input"
            placeholder="Group (optional)"
            list="add-device-groups"
            value={value.newGroup}
            onChange={(e) => onChange({ ...value, newGroup: e.target.value })}
            aria-label="Group for the new site"
          />
          <datalist id="add-device-groups">
            {groups.map((g) => <option key={g.id} value={g.name} />)}
          </datalist>
        </div>
      )}
    </div>
  );
}
