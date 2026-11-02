import { useQuery } from '@tanstack/react-query';
import { sitesApi } from '../services/api';
import { useSiteStore } from '../store/siteStore';
import { sitesInView } from '../utils/siteView';

/**
 * The sites chosen in the site selector, for lists of site-owned entries
 * that are fetched whole (credential presets, jump hosts): `view` is their
 * ids (null for every site) and `label` names the site or group.
 */
export function useSiteView(): { view: number[] | null; label: string | null } {
  const { currentSiteId, currentGroupId } = useSiteStore();
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data), staleTime: 300_000 });
  const view = sitesInView(currentSiteId, currentGroupId, sites);
  const label = currentSiteId != null
    ? sites.find((s) => s.id === currentSiteId)?.name ?? null
    : currentGroupId != null ? sites.find((s) => s.group_id === currentGroupId)?.group_name ?? null : null;
  return { view, label };
}
