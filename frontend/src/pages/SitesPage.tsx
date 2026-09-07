import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Building2, MapPin, Plus, Pencil, Trash2, Check, X, AlertCircle, RefreshCw } from 'lucide-react';
import { sitesApi, settingsApi } from '../services/api';
import { useSiteStore, type Site } from '../store/siteStore';
import { useCanWrite } from '../hooks/useCanWrite';
import { geocodeAddress, OSM_TILE_URL, OSM_ATTRIBUTION } from '../utils/geocode';

/** World map with one pin per site that has coordinates. */
function SitesMap({ sites, onSelect }: { sites: Site[]; onSelect: (id: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinned = sites.filter((s) => s.location_lat != null && s.location_lng != null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: false, worldCopyJump: true });
    L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION }).addTo(map);

    const points: [number, number][] = [];
    for (const s of pinned) {
      const lat = Number(s.location_lat);
      const lng = Number(s.location_lng);
      points.push([lat, lng]);
      const marker = L.circleMarker([lat, lng], {
        radius: 10, color: '#fff', weight: 2,
        fillColor: s.online_count > 0 ? '#3b82f6' : '#94a3b8',
        fillOpacity: 0.9,
      }).addTo(map);
      marker.bindPopup(
        `<b>${s.name}</b><br/>${s.address ?? ''}<br/>` +
        `${s.device_count} device${s.device_count === 1 ? '' : 's'}` +
        `${s.device_count ? ` &middot; ${s.online_count} online` : ''}`
      );
      marker.on('click', () => onSelect(s.id));
    }

    // Fit to the sites we have; fall back to a whole-world view when none are
    // geocoded yet, so the map is never a blank grey box.
    if (points.length === 1) map.setView(points[0], 11);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.25));
    else map.setView([20, 0], 2);

    return () => { map.remove(); };
  }, [JSON.stringify(pinned.map((s) => [s.id, s.location_lat, s.location_lng, s.online_count])), onSelect]);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-slate-700">
        <MapPin className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex-1">Site locations</h3>
        <span className="text-xs text-gray-400">
          {pinned.length} of {sites.length} mapped
        </span>
      </div>
      <div ref={containerRef} style={{ height: 420, isolation: 'isolate' }} />
    </div>
  );
}

export default function SitesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const { setCurrentSite } = useSiteStore();
  const [editing, setEditing] = useState<Site | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: sites = [], isLoading } = useQuery({
    queryKey: ['sites'],
    queryFn: () => sitesApi.list().then((r) => r.data),
  });

  // Geocoding and tiles are third-party requests that disclose where your
  // hardware is. Same off-switch as device locations (issue #106).
  const { data: settings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsApi.get().then((r) => r.data),
    staleTime: 300_000,
  });
  const mapsEnabled = settings?.['maps_enabled'] !== false;

  function openSite(id: number) {
    // Navigate before switching: setting the site remounts the tree (see
    // SiteScopedQueryProvider in main.tsx), so the route must be settled first.
    navigate('/dashboard');
    setCurrentSite(id);
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { setError('Site name is required'); return; }
    setBusy(true);
    setError('');
    try {
      const addr = address.trim();
      // Only geocode when maps are enabled and the address actually changed —
      // Nominatim is a courtesy service, not something to hammer on every save.
      let coords: { lat: number; lng: number } | null = null;
      const addressChanged = addr && addr !== (editing?.address ?? '');
      if (mapsEnabled && addressChanged) coords = await geocodeAddress(addr);

      const payload = {
        name: trimmed,
        address: addr,
        ...(addressChanged
          ? { location_lat: coords?.lat ?? null, location_lng: coords?.lng ?? null }
          : {}),
      };
      if (editing) await sitesApi.update(editing.id, payload);
      else await sitesApi.create(payload);
      await queryClient.invalidateQueries({ queryKey: ['sites'] });
      cancel();
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      setError(err.response?.data?.error ?? err.message ?? 'Could not save site');
    } finally {
      setBusy(false);
    }
  }

  const removeMutation = useMutation({
    mutationFn: (id: number) => sitesApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sites'] }),
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err.response?.data?.error ?? 'Could not delete site');
    },
  });

  function cancel() {
    setEditing(null); setAdding(false); setName(''); setAddress(''); setError('');
  }

  function startEdit(s: Site) {
    setEditing(s); setAdding(false); setName(s.name); setAddress(s.address ?? ''); setError('');
  }

  const totalDevices = sites.reduce((n, s) => n + s.device_count, 0);
  const totalOnline = sites.reduce((n, s) => n + s.online_count, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">All sites</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            {sites.length} site{sites.length === 1 ? '' : 's'} · {totalDevices} device
            {totalDevices === 1 ? '' : 's'} · {totalOnline} online
          </p>
        </div>
        {canWrite && !adding && !editing && (
          <button
            onClick={() => { setAdding(true); setName(''); setAddress(''); setError(''); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500"
          >
            <Plus className="w-4 h-4" /> New site
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')}><X className="w-4 h-4" /></button>
        </div>
      )}

      {(adding || editing) && (
        <div className="card p-4 space-y-3">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">
            {editing ? `Rename “${editing.name}”` : 'New site'}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Site name"
              className="input"
            />
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Address (optional)"
              className="input"
            />
          </div>
          <p className="text-xs text-gray-400">
            {mapsEnabled
              ? 'The address is geocoded so the site appears on the map above.'
              : 'Maps are disabled in Settings, so the address is stored as text only.'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={cancel} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-slate-600">
              Cancel
            </button>
          </div>
        </div>
      )}

      {mapsEnabled && sites.length > 0 && <SitesMap sites={sites} onSelect={openSite} />}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
              <th className="px-4 py-2.5 font-medium">Site</th>
              <th className="px-4 py-2.5 font-medium">Address</th>
              <th className="px-4 py-2.5 font-medium text-right">Devices</th>
              <th className="px-4 py-2.5 font-medium text-right">Online</th>
              {canWrite && <th className="px-4 py-2.5 w-20" />}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!isLoading && sites.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">No sites yet.</td></tr>
            )}
            {sites.map((s) => (
              <tr
                key={s.id}
                className="border-b border-gray-100 dark:border-slate-800 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-800/50 cursor-pointer"
                onClick={() => openSite(s.id)}
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <span className="font-medium text-gray-900 dark:text-white">{s.name}</span>
                    {s.is_default && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                        default
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">
                  {s.address || <span className="text-gray-300 dark:text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2.5 text-right text-gray-900 dark:text-white">{s.device_count}</td>
                <td className="px-4 py-2.5 text-right">
                  <span className={s.online_count === s.device_count && s.device_count > 0
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-gray-500 dark:text-slate-400'}>
                    {s.online_count}
                  </span>
                </td>
                {canWrite && (
                  <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => startEdit(s)}
                        className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400"
                        title="Rename"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => removeMutation.mutate(s.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-gray-400 hover:text-red-500"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
