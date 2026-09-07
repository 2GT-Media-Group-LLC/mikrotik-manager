import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Building2, ChevronDown, Check, Plus, Pencil, Globe, X } from 'lucide-react';
import clsx from 'clsx';
import { sitesApi } from '../../services/api';
import { useSiteStore, type Site } from '../../store/siteStore';
import { useCanWrite } from '../../hooks/useCanWrite';

interface Props {
  isCollapsed: boolean;
  onNavigate?: () => void;
}

/**
 * Site picker, mounted under the brand block (issue #130).
 *
 * Hidden entirely when only one site exists: a single-network install should
 * never have to learn what a site is.
 */
export default function SiteSelector({ isCollapsed, onNavigate }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const { currentSiteId, setCurrentSite } = useSiteStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Site | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => sitesApi.list().then((r) => r.data),
    staleTime: 60_000,
  });

  function closeAll() {
    setOpen(false);
    setCreating(false);
    setRenaming(null);
    setError('');
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeAll();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Site name is required');
      const payload = { name: trimmed, address: address.trim() };
      if (renaming) return sitesApi.update(renaming.id, payload).then((r) => r.data);
      return sitesApi.create(payload).then((r) => r.data);
    },
    onSuccess: (site) => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      // A newly created site is empty, so switching to it immediately is the
      // useful move: the next thing you do is add devices to it.
      if (!renaming) switchTo(site.id);
      closeAll();
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string });
      setError(msg.response?.data?.error ?? msg.message ?? 'Could not save site');
    },
  });

  /**
   * Changing the site changes the QueryClient's key in main.tsx, which remounts
   * the tree against an empty cache. Nothing to clear here -- and clearing was
   * in fact the bug: queryClient.clear() drops queries but leaves mounted
   * observers holding their last result, so the pages never updated.
   */
  function switchTo(id: number | null) {
    setCurrentSite(id);
    closeAll();
    onNavigate?.();
  }

  function openAllSites() {
    closeAll();
    onNavigate?.();
    // Navigate first: setting the site remounts the tree, and the route must
    // already be /sites when it comes back.
    navigate('/sites');
    setCurrentSite(null);
  }

  // Nothing to show until the site list arrives.
  if (sites.length === 0) return null;

  const current = currentSiteId == null ? null : sites.find((s) => s.id === currentSiteId) ?? null;

  // With one site there is nothing to choose between, so "all sites" and "that
  // site" describe the same set. Name it rather than saying "All sites", so a
  // single-network install sees "Default Site" and not a concept it never asked
  // for. Deliberately a display rule and not a state change: selecting it for
  // real would rekey the QueryClient and remount the app on every page load.
  const soleSite = sites.length === 1 ? sites[0] : null;
  const shown = current ?? soleSite;
  const label = shown?.name ?? 'All sites';

  return (
    <div ref={wrapRef} className="relative px-[14px] pt-3">
      <button
        onClick={() => (open ? closeAll() : setOpen(true))}
        className={clsx(
          'w-full flex items-center gap-2 rounded-lg px-2 py-2 transition-colors',
          'hover:bg-black/5 dark:hover:bg-white/5',
          isCollapsed && 'md:justify-center md:px-0'
        )}
        style={{ border: '1px solid var(--line)' }}
        title={label}
      >
        {shown
          ? <Building2 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--ink-3)' }} />
          : <Globe className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--ink-3)' }} />}
        <span
          className={clsx('flex-1 text-left text-[12.5px] font-medium truncate', isCollapsed && 'md:hidden')}
          style={{ color: 'var(--ink)' }}
        >
          {label}
        </span>
        <ChevronDown
          className={clsx('w-3.5 h-3.5 flex-shrink-0 transition-transform', open && 'rotate-180', isCollapsed && 'md:hidden')}
          style={{ color: 'var(--ink-4)' }}
        />
      </button>

      {open && (
        <div
          className="absolute left-[14px] right-[14px] mt-1 z-50 rounded-lg shadow-lg overflow-hidden"
          style={{ background: 'var(--surface)', border: '1px solid var(--line)', minWidth: 200 }}
        >
          {creating || renaming ? (
            <div className="p-3 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-4)' }}>
                {renaming ? 'Rename site' : 'New site'}
              </div>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveMutation.mutate(); if (e.key === 'Escape') closeAll(); }}
                placeholder="Site name"
                className="w-full px-2 py-1.5 text-[12.5px] rounded border bg-transparent"
                style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
              />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveMutation.mutate(); if (e.key === 'Escape') closeAll(); }}
                placeholder="Address (optional)"
                className="w-full px-2 py-1.5 text-[12.5px] rounded border bg-transparent"
                style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
              />
              {error && <div className="text-[11px] text-red-500">{error}</div>}
              <div className="flex gap-2">
                <button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  className="flex-1 px-2 py-1.5 text-[12px] rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {saveMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={closeAll}
                  className="px-2 py-1.5 text-[12px] rounded"
                  style={{ color: 'var(--ink-3)', border: '1px solid var(--line)' }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[10.5px] leading-snug" style={{ color: 'var(--ink-4)' }}>
                The address is geocoded for the all-sites map. Devices are moved between
                sites from the device list.
              </p>
            </div>
          ) : (
            <div className="py-1 max-h-[320px] overflow-y-auto">
              {sites.length > 1 && (
                <>
                  <button
                    onClick={openAllSites}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-black/5 dark:hover:bg-white/5"
                    style={{ color: 'var(--ink)' }}
                  >
                    <Globe className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--ink-3)' }} />
                    <span className="flex-1 text-left">All sites</span>
                    {currentSiteId == null && <Check className="w-3.5 h-3.5 text-blue-500" />}
                  </button>
                  <div className="my-1 h-px" style={{ background: 'var(--line)' }} />
                </>
              )}

              {sites.map((s) => (
                <div key={s.id} className="group flex items-center hover:bg-black/5 dark:hover:bg-white/5">
                  <button
                    onClick={() => switchTo(s.id)}
                    className="flex-1 flex items-center gap-2 px-3 py-1.5 text-[12.5px] min-w-0"
                    style={{ color: 'var(--ink)' }}
                  >
                    <Building2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--ink-3)' }} />
                    <span className="flex-1 text-left truncate">{s.name}</span>
                    <span className="text-[10.5px] flex-shrink-0" style={{ color: 'var(--ink-4)' }}>
                      {s.device_count}
                    </span>
                    {shown?.id === s.id && <Check className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}
                  </button>
                  {canWrite && (
                    <button
                      onClick={() => { setRenaming(s); setName(s.name); setAddress(s.address ?? ''); setError(''); }}
                      className="px-2 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: 'var(--ink-4)' }}
                      title={`Rename ${s.name}`}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}

              {canWrite && (
                <>
                  <div className="my-1 h-px" style={{ background: 'var(--line)' }} />
                  <button
                    onClick={() => { setCreating(true); setName(''); setAddress(''); setError(''); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-black/5 dark:hover:bg-white/5"
                    style={{ color: 'var(--ink-3)' }}
                  >
                    <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 text-left">New site</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
