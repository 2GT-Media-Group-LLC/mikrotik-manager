import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { credentialPresetsApi, sitesApi, type CredentialPreset } from '../services/api';
import { useSiteStore } from '../store/siteStore';

/** Presets that can apply to a device in `siteId`: fleet-wide ones and that site's own. */
export function presetsForSite<T extends { site_id?: number | null }>(presets: T[], siteId: number | null): T[] {
  return presets.filter((p) => p.site_id == null || p.site_id === siteId);
}

/**
 * The credential presets for devices being added now (#228): a new device
 * joins the selected site, or the default site when none is selected, so only
 * fleet-wide presets and that site's are offered. Names are unique per site,
 * so this is also what CSV import matches names against.
 */
export function useSitePresets(): { presets: CredentialPreset[]; isLoading: boolean } {
  const currentSiteId = useSiteStore((s) => s.currentSiteId);
  const { data: all = [], isLoading } = useQuery({
    queryKey: ['credential-presets'],
    queryFn: () => credentialPresetsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data), staleTime: 300_000 });
  const target = currentSiteId ?? sites.find((s) => s.is_default)?.id ?? null;
  const presets = useMemo(() => presetsForSite(all, target), [all, target]);
  return { presets, isLoading };
}
