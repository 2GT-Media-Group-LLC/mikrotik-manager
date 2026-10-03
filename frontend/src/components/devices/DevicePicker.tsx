import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { sitesApi } from '../../services/api';
import type { Device } from '../../types';
import DeviceTypePill from './DeviceTypePill';
import TagChips from './TagChips';

/**
 * Choosing devices (#218): grouped by site, each with its type badge and tags,
 * a select-all per site, and a search once the list is long. Used for
 * maintenance windows and bulk commands, which were plain checkbox lists.
 */
export default function DevicePicker({
  devices, selected, onChange, maxHeight = 'max-h-72',
}: {
  devices: Device[];
  selected: number[];
  onChange: (ids: number[]) => void;
  maxHeight?: string;
}) {
  const [search, setSearch] = useState('');
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data), staleTime: 300_000 });
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const shown = devices.filter((d) => !q || [d.name, d.ip_address, d.model, ...(d.tags ?? []).map((t) => t.name)]
      .some((v) => v && String(v).toLowerCase().includes(q)));
    const bySite = new Map<number | null, Device[]>();
    for (const d of shown) {
      const key = d.site_id ?? null;
      if (!bySite.has(key)) bySite.set(key, []);
      bySite.get(key)!.push(d);
    }
    return [...bySite.entries()]
      .map(([id, list]) => ({ id, name: id == null ? 'No site' : siteName.get(id) ?? `Site ${id}`, list: list.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [devices, search, siteName]);

  const chosen = new Set(selected);
  const toggle = (id: number) => onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const setGroup = (list: Device[], on: boolean) => {
    const ids = new Set(list.map((d) => d.id));
    onChange(on ? [...new Set([...selected, ...ids])] : selected.filter((x) => !ids.has(x)));
  };
  const showHeaders = groups.length > 1;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
      {devices.length > 10 && (
        <div className="relative border-b border-gray-200 dark:border-slate-700">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="w-full bg-transparent pl-8 pr-3 py-1.5 text-xs outline-none" placeholder="Search devices or tags"
            value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search devices" />
        </div>
      )}
      <div className={`${maxHeight} overflow-y-auto`}>
        {groups.length === 0 && <div className="px-3 py-3 text-xs text-gray-400 dark:text-slate-500">No devices match.</div>}
        {groups.map((g) => {
          const inGroup = g.list.filter((d) => chosen.has(d.id)).length;
          return (
            <div key={g.id ?? 'none'}>
              {showHeaders && (
                <label className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-slate-800/60 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 cursor-pointer select-none sticky top-0">
                  <input type="checkbox" checked={inGroup === g.list.length}
                    ref={(el) => { if (el) el.indeterminate = inGroup > 0 && inGroup < g.list.length; }}
                    onChange={(e) => setGroup(g.list, e.target.checked)} aria-label={`Select every device in ${g.name}`} />
                  {g.name}
                  <span className="font-normal normal-case tracking-normal">{inGroup}/{g.list.length}</span>
                </label>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2">
                {g.list.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/40 min-w-0">
                    <input type="checkbox" checked={chosen.has(d.id)} onChange={() => toggle(d.id)} />
                    <DeviceTypePill type={d.device_type} />
                    <span className="truncate text-gray-900 dark:text-white font-medium">{d.name.trim()}</span>
                    <TagChips tags={d.tags} />
                    {d.status !== 'online' && <span className="text-[10px] text-gray-400">offline</span>}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
