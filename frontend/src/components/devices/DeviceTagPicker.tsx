import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Tag as TagIcon, X, Plus, Check } from 'lucide-react';
import { tagsApi } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';

/**
 * Putting tags on a device.
 *
 * Tags had a table, endpoints, a settings screen to create them, a filter on
 * the device list and chips ready to render on each row — and nothing anywhere
 * that called `assignDevices`. A user asked, reasonably, whether tags were
 * supported at all: he could create one and watch it sit at "0 devices" with no
 * way to put it on anything (#149).
 *
 * The API is tag-centric — `POST /tags/:id/devices` with a list — because it
 * was built for bulk assignment. People think device-centric: "tag this
 * device". This translates between the two.
 */

interface Props {
  deviceId: number;
}

export default function DeviceTagPicker({ deviceId }: Props) {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Fetched rather than passed: the single-device payload carries no tags, only
  // the list endpoint does, and this renders on the detail page.
  const { data: tags = [] } = useQuery({
    queryKey: ['device-tags', deviceId],
    queryFn: () => tagsApi.forDevice(deviceId).then((r) => r.data),
  });

  const { data: allTags = [] } = useQuery({
    queryKey: ['tags'],
    queryFn: () => tagsApi.list().then((r) => r.data),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const assigned = new Set(tags.map((t) => t.id));

  const toggle = useMutation({
    mutationFn: ({ tagId, action }: { tagId: number; action: 'add' | 'remove' }) =>
      tagsApi.assignDevices(tagId, [deviceId], action),
    onSuccess: () => {
      // The device payload carries its own tags, and the list page renders
      // chips from the same source, so both have to be refreshed.
      qc.invalidateQueries({ queryKey: ['device-tags', deviceId] });
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
    },
  });

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1.5 flex-wrap">
      {tags.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
          style={{ background: `${t.color}22`, color: t.color }}
        >
          {t.name}
          {canWrite && (
            <button
              onClick={() => toggle.mutate({ tagId: t.id, action: 'remove' })}
              className="opacity-60 hover:opacity-100"
              title={`Remove ${t.name}`}
              disabled={toggle.isPending}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}

      {canWrite && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border border-dashed"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-4)' }}
          title="Add a tag"
        >
          {tags.length === 0 ? <><TagIcon className="w-3 h-3" /> Tag</> : <Plus className="w-3 h-3" />}
        </button>
      )}

      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-30 min-w-[180px] rounded-lg border shadow-lg py-1"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}
        >
          {allTags.length === 0 ? (
            <p className="px-3 py-2 text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
              No tags yet — create them in Settings → Tags.
            </p>
          ) : (
            allTags.map((t) => {
              const on = assigned.has(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggle.mutate({ tagId: t.id, action: on ? 'remove' : 'add' })}
                  disabled={toggle.isPending}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: 'var(--ink)' }}
                >
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: t.color }} />
                  <span className="flex-1 text-left truncate">{t.name}</span>
                  {on && <Check className="w-3.5 h-3.5 text-blue-500" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
