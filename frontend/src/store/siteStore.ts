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
