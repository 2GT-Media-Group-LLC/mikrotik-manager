import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MapPin, Building2, Hash, FileText, Pencil, Check, X, RefreshCw, AlertCircle,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { devicesApi, settingsApi } from '../../services/api';
import type { Device } from '../../types';
import { useCanWrite } from '../../hooks/useCanWrite';

interface Props {
  device: Device;
}

interface LocationForm {
  location_address: string;
  rack_name: string;
  rack_slot: string;
  notes: string;
}

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
      { headers: { Accept: 'application/json' } }
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch {
    // ignore geocoding failures
  }
  return null;
}

function MapEmbed({ lat, lng, address }: { lat: number | string; lng: number | string; address: string }) {
  const latN = Number(lat);
  const lngN = Number(lng);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.circleMarker([latN, lngN], {
      radius: 9, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9,
    }).bindPopup(`<b>${address}</b>`).addTo(map);
    map.setView([latN, lngN], 15);
    return () => { map.remove(); };
  }, [latN, lngN, address]);

  return (
    <div className="card overflow-hidden h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-slate-700">
        <MapPin className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex-1 truncate">
          {address}
        </h3>
        <a
          href={`https://www.openstreetmap.org/?mlat=${latN}&mlon=${lngN}#map=16/${latN}/${lngN}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-500 hover:text-blue-400 whitespace-nowrap"
        >
          Open map ↗
        </a>
      </div>
      <div ref={containerRef} style={{ height: 280, isolation: 'isolate' }} />
    </div>
  );
}

export default function DeviceLocationSection({ device }: Props) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  // Geocoding and tiles are third-party requests that also disclose where your
  // devices are. Operators on isolated networks can turn the whole thing off
  // (issue #106); coordinates already stored are still shown as plain text.
  const { data: settings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsApi.get().then(r => r.data),
    staleTime: 300_000,
  });
  const mapsEnabled = settings?.['maps_enabled'] !== false;
  const [editing, setEditing] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [form, setForm] = useState<LocationForm>({
    location_address: device.location_address ?? '',
    rack_name: device.rack_name ?? '',
    rack_slot: device.rack_slot ?? '',
    notes: device.notes ?? '',
  });

  const hasMap = device.location_lat != null && device.location_lng != null
    && !isNaN(Number(device.location_lat)) && !isNaN(Number(device.location_lng));

  const mutation = useMutation({
    mutationFn: async (f: LocationForm) => {
      setSaveError('');
      let lat: number | null = device.location_lat ?? null;
      let lng: number | null = device.location_lng ?? null;

      // Re-geocode if address changed
      const addressChanged = f.location_address !== (device.location_address ?? '');
      if (mapsEnabled && f.location_address && addressChanged) {
        setGeocoding(true);
        const coords = await geocodeAddress(f.location_address);
        setGeocoding(false);
        if (coords) {
          lat = coords.lat;
          lng = coords.lng;
        } else {
          lat = null;
          lng = null;
        }
      }
      // Clear coords if address was cleared
      if (!f.location_address) { lat = null; lng = null; }

      return devicesApi.patchLocation(device.id, {
        location_address: f.location_address || null,
        location_lat:     lat,
        location_lng:     lng,
        rack_name:        f.rack_name || null,
        rack_slot:        f.rack_slot || null,
        notes:            f.notes    || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['device', device.id] });
      setEditing(false);
    },
    onError: (err: unknown) => {
      setGeocoding(false);
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg || 'Failed to save');
    },
  });

  const openEdit = () => {
    setForm({
      location_address: device.location_address ?? '',
      rack_name: device.rack_name ?? '',
      rack_slot: device.rack_slot ?? '',
      notes: device.notes ?? '',
    });
    setSaveError('');
    setEditing(true);
  };

  const cancelEdit = () => { setEditing(false); setSaveError(''); };

  const isPending = mutation.isPending || geocoding;

  return (
    <div className={`grid gap-4 ${hasMap && !editing ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
      {/* Info / edit card */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Physical Details</h3>
          {canWrite && !editing && (
            <button onClick={openEdit} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5">
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
          )}
        </div>

        {editing ? (
          <div className="space-y-4">
            <div>
              <label className="label flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-blue-500" /> Physical Location
              </label>
              <input
                className="input"
                value={form.location_address}
                onChange={(e) => setForm((f) => ({ ...f, location_address: e.target.value }))}
                placeholder="123 Main St, City, State 00000"
              />
              <p className="text-xs text-gray-400 mt-1">Address will be geocoded and shown on the map.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-blue-500" /> Rack Name
                </label>
                <input
                  className="input"
                  value={form.rack_name}
                  onChange={(e) => setForm((f) => ({ ...f, rack_name: e.target.value }))}
                  placeholder="Rack-A1"
                />
              </div>
              <div>
                <label className="label flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5 text-blue-500" /> Rack Slot
                </label>
                <input
                  className="input"
                  value={form.rack_slot}
                  onChange={(e) => setForm((f) => ({ ...f, rack_slot: e.target.value }))}
                  placeholder="U3"
                />
              </div>
            </div>
            <div>
              <label className="label flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-blue-500" /> Notes
              </label>
              <textarea
                className="input resize-none"
                rows={4}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Any relevant notes about this device..."
              />
            </div>

            {saveError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={() => mutation.mutate(form)}
                disabled={isPending}
                className="btn-primary flex items-center gap-2 text-sm"
              >
                {isPending
                  ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />{geocoding ? 'Geocoding…' : 'Saving…'}</>
                  : <><Check className="w-3.5 h-3.5" />Save</>
                }
              </button>
              <button onClick={cancelEdit} disabled={isPending} className="btn-secondary text-sm">
                <X className="w-3.5 h-3.5 inline mr-1" />Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <InfoRow icon={<MapPin className="w-3.5 h-3.5 text-blue-500" />} label="Location"
              value={device.location_address}
              emptyText="No location set" />
            <InfoRow icon={<Building2 className="w-3.5 h-3.5 text-blue-500" />} label="Rack"
              value={device.rack_name}
              emptyText="No rack assigned" />
            <InfoRow icon={<Hash className="w-3.5 h-3.5 text-blue-500" />} label="Rack Slot"
              value={device.rack_slot}
              emptyText="—" />
            <div className="pt-1 border-t border-gray-100 dark:border-slate-700">
              <div className="flex items-start gap-2 mt-2">
                <FileText className="w-3.5 h-3.5 text-blue-500 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <span className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide block mb-1">Notes</span>
                  {device.notes
                    ? <p className="text-gray-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">{device.notes}</p>
                    : <p className="text-gray-400 dark:text-slate-500 italic">No notes</p>
                  }
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Map card — only when we have coordinates, are not editing, and outbound
          map requests are permitted. */}
      {hasMap && !editing && mapsEnabled && (
        <MapEmbed
          lat={device.location_lat!}
          lng={device.location_lng!}
          address={device.location_address!}
        />
      )}
    </div>
  );
}

function InfoRow({
  icon, label, value, emptyText,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | undefined;
  emptyText: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide block mb-0.5">
          {label}
        </span>
        {value
          ? <span className="text-gray-900 dark:text-white">{value}</span>
          : <span className="text-gray-400 dark:text-slate-500 italic">{emptyText}</span>
        }
      </div>
    </div>
  );
}
