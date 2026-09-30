import { useEffect } from 'react';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';

/**
 * Keep the signed-in account's role and site access current (P1-7). An admin
 * can change them at any time and the server applies that at once; this brings
 * the interface along on load, every few minutes, and when the window regains
 * focus. A site no longer allowed is dropped from the selection.
 */
export function useAccessRefresh(): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const refresh = () => {
      authApi.me()
        .then((r) => {
          if (cancelled) return;
          const me = (r.data as { user?: { role?: string; siteRoles?: Record<string, string> } }).user ?? {};
          // Also drops a site selection the account can no longer use.
          useAuthStore.getState().applyAccess(me);
        })
        .catch(() => { /* a 401 is handled by the API client */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 5 * 60_000);
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [isAuthenticated]);
}
