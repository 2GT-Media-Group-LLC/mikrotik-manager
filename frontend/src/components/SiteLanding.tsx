import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { sitesApi } from '../services/api';
import { useSiteStore } from '../store/siteStore';

/**
 * Where "/" goes (issue #130).
 *
 * One site means a single-network install, which must never meet the concept:
 * straight to the dashboard. More than one, with no site chosen, means the
 * all-sites overview is the honest landing page — a dashboard aggregating
 * several customers' networks would be a number nobody asked for.
 */
export default function SiteLanding() {
  const { currentSiteId } = useSiteStore();
  const { data: sites, isLoading } = useQuery({
    queryKey: ['sites'],
    queryFn: () => sitesApi.list().then((r) => r.data),
    staleTime: 60_000,
  });

  // Don't bounce through /sites while the list is still in flight.
  if (isLoading) return null;
  if (currentSiteId == null && (sites?.length ?? 0) > 1) return <Navigate to="/sites" replace />;
  return <Navigate to="/dashboard" replace />;
}
