import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { useSiteStore } from './store/siteStore';
import './index.css';

// Initialize theme from storage immediately
const storedTheme = (() => {
  try {
    const raw = localStorage.getItem('mikrotik-theme');
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.state?.theme;
    }
  } catch {
    // localStorage unavailable (e.g. sandboxed iframe) — leave as default
  }
  return 'light';
})();
if (storedTheme === 'dark') {
  document.documentElement.classList.add('dark');
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/**
 * Scopes the whole React Query cache to the active site (issue #130).
 *
 * The obvious move -- queryClient.clear() on switch -- does not work, and the
 * reason is worth recording. clear() destroys each Query and drops it from the
 * cache, but a *mounted* observer keeps its own reference and last result, and
 * nothing re-subscribes it. Every already-rendered page therefore went on
 * displaying the previous site's data.
 *
 * Keying the provider on the site is what actually holds: a changed key
 * unmounts the entire subtree and remounts it against a brand-new, empty cache,
 * so every query refetches with the new X-Site-Id header. There is no path by
 * which one site's data can survive into another's view.
 *
 * The cost is a full remount on switch. That is the honest price of changing
 * context, and it only happens when the operator deliberately switches.
 */
function SiteScopedQueryProvider({ children }: { children: React.ReactNode }) {
  const siteId = useSiteStore((s) => s.currentSiteId);
  const key = siteId == null ? 'all' : String(siteId);
  // A new cache per site; `key` is the dependency on purpose.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const client = React.useMemo(() => makeQueryClient(), [key]);
  return (
    <QueryClientProvider key={key} client={client}>
      {children}
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SiteScopedQueryProvider>
      <App />
    </SiteScopedQueryProvider>
  </React.StrictMode>
);
