import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import L from 'leaflet';
import clsx from 'clsx';
import 'leaflet/dist/leaflet.css';
import { Building2, MapPin, Plus, Pencil, Trash2, Check, X, AlertCircle, RefreshCw } from 'lucide-react';
import { sitesApi, settingsApi, siteGroupsApi, jumpHostsApi } from '../services/api';
import { useSiteStore, type Site } from '../store/siteStore';
import { useCanWrite, useIsSiteScoped } from '../hooks/useCanWrite';
import GroupsCard from '../components/sites/GroupsCard';
import RomonCard from '../components/sites/RomonCard';
import { geocodeAddress, NOT_ON_MAP, OSM_TILE_URL, OSM_ATTRIBUTION, parseCoords, formatCoords } from '../utils/geocode';
import { escapeHtml } from '../utils/escapeHtml';
import PollOverridesCard from '../components/common/PollOverridesCard';

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
        `<b>${escapeHtml(s.name)}</b><br/>${escapeHtml(s.address ?? '')}<br/>` +
        `${s.device_count} device${s.device_count === 1 ? '' : 's'}` +
        `${s.device_count ? ` &middot; ${s.online_count} online` : ''}`
      );
      marker.on('click', () => onSelect(s.id));
    }

    // Fit to the sites we have; fall back to a whole-world view when none are
    // geocoded yet, so the map is never a blank grey box.
    if (points.length === 1) map.setView(points[0], pinned[0].map_zoom ?? 11);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.25));
    else map.setView([20, 0], 2);

    return () => { map.remove(); };
  }, [JSON.stringify(pinned.map((s) => [s.id, s.location_lat, s.location_lng, s.map_zoom, s.online_count])), onSelect]);

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

/**
 * Click to put the site's pin where it is (#362), for when the address can't
 * be found or isn't precise enough. Starts on the current pin, or the world.
 */
function PinPicker({ value, zoom, onPick, onZoom }: {
  value: { lat: number; lng: number } | null; zoom: number | null;
  onPick: (lat: number, lng: number) => void; onZoom: (zoom: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: true, worldCopyJump: true });
    L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => onPickRef.current(e.latlng.lat, L.Util.wrapNum(e.latlng.lng, [-180, 180], true)));
    map.on('zoomend', () => onZoomRef.current(map.getZoom()));
    mapRef.current = map;
    if (value) map.setView([value.lat, value.lng], zoom ?? 13); else map.setView([20, 0], 2);
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // The view is set once; later pins only move the marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lat = value?.lat;
  const lng = value?.lng;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (lat == null || lng == null) { markerRef.current?.remove(); markerRef.current = null; return; }
    if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
    else markerRef.current = L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9 }).addTo(map);
  }, [lat, lng]);

  return <div ref={containerRef} className="rounded-lg overflow-hidden border border-gray-200 dark:border-slate-700 cursor-crosshair"
    style={{ height: 260, isolation: 'isolate' }} aria-label="Click the map to place the site" />;
}

export default function SitesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const { setCurrentSite, setCurrentGroup } = useSiteStore();
  // Groups are managed by fleet-wide accounts (#306).
  const isScoped = useIsSiteScoped();
  const [groupId, setGroupId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const { data: groups = [] } = useQuery({
    queryKey: ['site-groups'],
    queryFn: () => siteGroupsApi.list().then((r) => r.data),
  });
  const [editing, setEditing] = useState<Site | null>(null);
  // The jump host new devices in the site are reached through; null for direct.
  const [defaultJumpHost, setDefaultJumpHost] = useState<number | null>(null);
  const { data: jumpHosts = [] } = useQuery({
    queryKey: ['jump-hosts'],
    queryFn: () => jumpHostsApi.list().then((r) => r.data),
    staleTime: 60_000,
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  // The pin, as typed or picked on the map (#362). Untouched, saving
  // geocodes a changed address as before; touched, the pin is what's saved.
  const [coordsText, setCoordsText] = useState('');
  const [coordsTouched, setCoordsTouched] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  // The zoom the site's map opens at (#362), as typed; blank fits the map.
  const [zoomText, setZoomText] = useState('');
  const [pickerZoom, setPickerZoom] = useState<number | null>(null);
  const zoomValue = zoomText.trim() === '' ? null : Number(zoomText);
  const zoomBad = zoomValue !== null && !(Number.isInteger(zoomValue) && zoomValue >= 1 && zoomValue <= 19);
  const typedCoords = parseCoords(coordsText);
  const pin = typedCoords && !('empty' in typedCoords) ? typedCoords : null;
  // A saved site whose address couldn't be placed on the map (#362).
  const [mapNote, setMapNote] = useState('');
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
  // Off until settings have loaded (outside review U6): unknown used to count as on,
  // so a Dark Site install fetched map tiles and geocoding before, or without, the setting.
  const mapsEnabled = settings !== undefined && settings['maps_enabled'] !== false;

  function openSite(id: number) {
    // Navigate before switching: setting the site remounts the tree (see
    // SiteScopedQueryProvider in main.tsx), so the route must be settled first.
    navigate('/dashboard');
    setCurrentSite(id);
  }

  function openGroup(id: number) {
    navigate('/dashboard');
    setCurrentGroup(id);
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { setError('Site name is required'); return; }
    if (coordsTouched && !typedCoords) { setError('Map position must be a latitude and longitude, like 51.5072, -0.1276'); return; }
    if (zoomBad) { setError('Map zoom is a whole number from 1 (the world) to 19 (a building), or blank to fit the map.'); return; }
    setBusy(true);
    setError('');
    try {
      const addr = address.trim();
      // Only geocode when maps are enabled and the address actually changed —
      // Nominatim is a courtesy service, not something to hammer on every save.
      let coords: { lat: number; lng: number } | null = null;
      const addressChanged = addr && addr !== (editing?.address ?? '');
      if (mapsEnabled && addressChanged && !coordsTouched) coords = await geocodeAddress(addr);
      // Saved either way; say so when the address couldn't be placed (#362).
      setMapNote(mapsEnabled && addressChanged && !coordsTouched && !coords
        ? `${trimmed}: ${NOT_ON_MAP} Or edit the site and place it on the map by hand.` : '');

      const payload = {
        name: trimmed,
        address: addr,
        ...(!isScoped && (editing ? (editing.group_id ?? null) !== groupId : groupId != null) ? { group_id: groupId } : {}),
        ...(editing && (editing.default_jump_host_id ?? null) !== defaultJumpHost ? { default_jump_host_id: defaultJumpHost } : {}),
        ...((editing?.map_zoom ?? null) !== zoomValue ? { map_zoom: zoomValue } : {}),
        ...(coordsTouched
          ? { location_lat: pin?.lat ?? null, location_lng: pin?.lng ?? null }
          : addressChanged
            ? { location_lat: coords?.lat ?? null, location_lng: coords?.lng ?? null }
            : {}),
      };
      if (editing) await sitesApi.update(editing.id, payload);
      else await sitesApi.create(payload);
      await queryClient.invalidateQueries({ queryKey: ['sites'] });
      await queryClient.invalidateQueries({ queryKey: ['site-groups'] });
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
    setEditing(null); setAdding(false); setName(''); setAddress(''); setError(''); setGroupId(null); setDefaultJumpHost(null);
    setCoordsText(''); setCoordsTouched(false); setShowPicker(false); setZoomText(''); setPickerZoom(null);
  }

  function startEdit(s: Site) {
    setEditing(s); setAdding(false); setName(s.name); setAddress(s.address ?? ''); setError(''); setGroupId(s.group_id ?? null);
    setDefaultJumpHost(s.default_jump_host_id ?? null);
    setCoordsText(s.location_lat != null && s.location_lng != null ? formatCoords(Number(s.location_lat), Number(s.location_lng)) : '');
    setCoordsTouched(false); setShowPicker(false);
    setZoomText(s.map_zoom != null ? String(s.map_zoom) : ''); setPickerZoom(null);
  }

  // A site's own jump hosts and fleet-wide ones.
  const jumpHostChoices = editing ? jumpHosts.filter((j) => j.site_id == null || j.site_id === editing.id) : [];

  const q = filter.trim().toLowerCase();
  const shownSites = q ? sites.filter((s) => [s.name, s.address, s.group_name].some((v) => (v ?? '').toLowerCase().includes(q))) : sites;
  const anyGroups = sites.some((s) => s.group_id != null);

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

      {mapNote && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <p className="flex-1">{mapNote}</p>
          <button type="button" onClick={() => setMapNote('')} className="opacity-60 hover:opacity-100 text-xs" aria-label="Dismiss">✕</button>
        </div>
      )}

      {(adding || editing) && (
        <div className="card p-4 space-y-3">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">
            {editing ? `Edit “${editing.name}”` : 'New site'}
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
            {!isScoped && (
              <label className="flex items-center gap-2 text-sm sm:col-span-2" style={{ color: 'var(--ink-3)' }}>
                Group
                <select className="input max-w-xs" value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">No group</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <span className="text-xs" style={{ color: 'var(--ink-4)' }}>The customer it belongs to. New groups are made under Groups below.</span>
              </label>
            )}
            {editing && (jumpHostChoices.length > 0 || defaultJumpHost != null) && (
              <label className="flex items-center gap-2 text-sm sm:col-span-2" style={{ color: 'var(--ink-3)' }}>
                New devices connect
                <select className="input max-w-xs" value={defaultJumpHost ?? ''} onChange={(e) => setDefaultJumpHost(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Directly</option>
                  {jumpHostChoices.map((j) => <option key={j.id} value={j.id}>Via {j.name} ({j.host})</option>)}
                </select>
                <span className="text-xs" style={{ color: 'var(--ink-4)' }}>The default when adding a device here. Devices already in the site keep their own setting.</span>
              </label>
            )}
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm flex-wrap" style={{ color: 'var(--ink-3)' }}>
              Map position
              <input
                value={coordsText}
                onChange={(e) => { setCoordsText(e.target.value); setCoordsTouched(true); }}
                placeholder={mapsEnabled ? 'From the address, or latitude, longitude' : 'Latitude, longitude'}
                aria-invalid={coordsTouched && !typedCoords}
                className={clsx('input max-w-xs mono', coordsTouched && !typedCoords && 'border-red-400 dark:border-red-500')}
              />
              {mapsEnabled && (
                <button type="button" onClick={() => setShowPicker((v) => !v)} className="btn-secondary text-xs py-1 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" /> {showPicker ? 'Hide map' : 'Pick on map'}
                </button>
              )}
              {pin && (
                <button type="button" onClick={() => { setCoordsText(''); setCoordsTouched(true); }} className="text-xs underline" style={{ color: 'var(--ink-4)' }}>
                  remove pin
                </button>
              )}
            </label>
            {coordsTouched && !typedCoords && (
              <p className="text-xs text-red-600 dark:text-red-400">Type a latitude and longitude, like 51.5072, -0.1276, or leave it empty for no pin.</p>
            )}
            <label className="flex items-center gap-2 text-sm flex-wrap" style={{ color: 'var(--ink-3)' }}>
              Map zoom
              <input value={zoomText} onChange={(e) => setZoomText(e.target.value)} placeholder="fit" inputMode="numeric"
                aria-invalid={zoomBad} className={clsx('input w-20 mono', zoomBad && 'border-red-400 dark:border-red-500')} />
              <span className="text-xs" style={{ color: zoomBad ? undefined : 'var(--ink-4)' }}>
                {zoomBad
                  ? <span className="text-red-600 dark:text-red-400">1 (the world) to 19 (a building), or blank to fit the map.</span>
                  : 'The zoom this site\u2019s map opens at: 12 is about street level. Blank fits the map to its devices.'}
              </span>
              {mapsEnabled && showPicker && pickerZoom != null && String(pickerZoom) !== zoomText.trim() && (
                <button type="button" onClick={() => setZoomText(String(pickerZoom))} className="btn-secondary text-xs py-1">
                  Use the map&apos;s zoom ({pickerZoom})
                </button>
              )}
            </label>
            {mapsEnabled && showPicker && (
              <PinPicker value={pin} zoom={zoomBad ? null : zoomValue} onZoom={setPickerZoom}
                onPick={(lat, lng) => { setCoordsText(formatCoords(lat, lng)); setCoordsTouched(true); }} />
            )}
          </div>
          <p className="text-xs text-gray-400">
            {mapsEnabled
              ? 'The address is geocoded so the site appears on the map above. To place it yourself, type its position or pick it on the map; that wins over the address.'
              : 'Maps are disabled in Settings, so nothing is looked up. A position typed here is stored and used if maps are turned on.'}
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

      {/* Poll intervals and backups for the site's devices (#261) */}
      {editing && <PollOverridesCard scope="site" id={editing.id} siteId={editing.id} />}

      {mapsEnabled && sites.length > 0 && <SitesMap sites={sites} onSelect={openSite} />}

      {/* Groups of sites, one per customer (#306) */}
      <GroupsCard sites={sites} canManage={canWrite && !isScoped} onOpen={openGroup} />

      {/* RoMON per site or group (#311) */}
      <RomonCard sites={sites} />

      {sites.length > 10 && (
        <input className="input max-w-sm" placeholder="Find a site by name, address or group" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a site" />
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
              <th className="px-4 py-2.5 font-medium">Site</th>
              {anyGroups && <th className="px-4 py-2.5 font-medium">Group</th>}
              <th className="px-4 py-2.5 font-medium">Address</th>
              <th className="px-4 py-2.5 font-medium text-right">Devices</th>
              <th className="px-4 py-2.5 font-medium text-right">Online</th>
              {canWrite && <th className="px-4 py-2.5 w-20" />}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!isLoading && sites.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No sites yet.</td></tr>
            )}
            {shownSites.map((s) => (
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
                {anyGroups && (
                  <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">
                    {s.group_name ?? <span className="text-gray-300 dark:text-slate-600">—</span>}
                  </td>
                )}
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
