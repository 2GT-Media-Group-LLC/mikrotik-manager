import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Site {
  id: number;
  name: string;
  address: string | null;
  location_lat: number | null;
  location_lng: number | null;
  notes: string | null;
  is_default: boolean;
  device_count: number;
  online_count: number;
}

/** null = the all-sites view; a number = that site. */
export type SiteSelection = number | null;

interface SiteState {
  currentSiteId: SiteSelection;
  setCurrentSite: (id: SiteSelection) => void;
}

/**
 * Drop a site selection the signed-in account can't use (P1-7). The selection
 * is remembered in the browser across sign-ins, so the previous account's site
 * would otherwise be sent with every request and refused. An account limited to
 * one site lands on it; one with several lands on the all-sites view, which the
 * server narrows to its sites. Fleet-wide accounts (no siteRoles) are left alone.
 */
export function reconcileSiteSelection(siteRoles: Record<string, string> | null | undefined): void {
  if (!siteRoles) return;
  const allowed = Object.keys(siteRoles).map(Number).filter((n) => Number.isFinite(n));
  if (allowed.length === 0) return;
  const { currentSiteId, setCurrentSite } = useSiteStore.getState();
  if (currentSiteId != null && allowed.includes(currentSiteId)) return;
  const next = allowed.length === 1 ? allowed[0] : null;
  if (next !== currentSiteId) setCurrentSite(next);
}

export const useSiteStore = create<SiteState>()(
  persist(
    (set) => ({
      // Undefined until the site list loads. A brand-new install has exactly one
      // site, and App resolves the selection to it, so single-site deployments
      // never see the concept.
      currentSiteId: null,
      setCurrentSite: (id) => set({ currentSiteId: id }),
    }),
    {
      name: 'mikrotik-site',
      partialize: (state) => ({ currentSiteId: state.currentSiteId }),
    }
  )
);
