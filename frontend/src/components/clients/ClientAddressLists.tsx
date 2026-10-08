import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, AlertTriangle, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import FloatingWindow from '../common/FloatingWindow';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';
import { devicesApi, type ClientAddressListView } from '../../services/api';
import type { Device } from '../../types';

/**
 * A client's firewall address lists on one router (#145): tick to add, untick
 * to remove, or type a new list. An address can be in any number of lists, so
 * this is a checklist rather than a single choice. Entries a firewall rule
 * added are shown but can't be changed; lists a rule matches on are marked,
 * and every change runs through Change Guard's lockout prediction.
 */
export default function ClientAddressLists({ address, clientName, defaultDeviceId, onClose }: {
  address: string;
  clientName: string;
  /** The device the client was seen on; used when it can hold address lists. */
  defaultDeviceId?: number | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: () => devicesApi.list().then((r) => r.data), staleTime: 60_000 });
  // Routers first: address lists usually live on the firewall.
  const choices = useMemo(() => [...(devices as Device[])]
    .filter((d) => d.status === 'online')
    .sort((a, b) => Number(b.device_type === 'router') - Number(a.device_type === 'router') || a.name.localeCompare(b.name)), [devices]);
  // The router the client was seen on when it is one, else the first router.
  const [picked, setPicked] = useState<number | null>(null);
  const fallback = choices.find((d) => d.id === defaultDeviceId && d.device_type === 'router') ?? choices[0];
  const deviceId = picked ?? fallback?.id ?? null;

  const { data: view, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['client-address-lists', deviceId, address],
    queryFn: () => devicesApi.clientAddressLists(deviceId!, address).then((r) => r.data),
    enabled: deviceId !== null,
  });

  const [wanted, setWanted] = useState<Set<string> | null>(null);
  const [newList, setNewList] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<{ ok: boolean; text: string }[]>([]);
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);

  const memberOf = (v: ClientAddressListView) => new Set(v.member.map((m) => m.list));
  const current = view ? (wanted ?? memberOf(view)) : new Set<string>();
  const toggle = (list: string) => {
    if (!view) return;
    const next = new Set(current);
    if (next.has(list)) next.delete(list); else next.add(list);
    setWanted(next);
  };

  const apply = async () => {
    if (!view || deviceId === null) return;
    const target = new Set(current);
    const name = newList.trim();
    if (name) target.add(name);
    const have = memberOf(view);
    const adds = [...target].filter((l) => !have.has(l));
    const removes = view.member.filter((m) => !m.dynamic && !target.has(m.list));
    setBusy(true);
    setNotes([]);
    const out: { ok: boolean; text: string }[] = [];
    // One change at a time, each through Change Guard. A predicted lockout
    // stops here and asks; confirming sends that one again.
    const step = async (label: string, send: (confirm: boolean) => Promise<unknown>): Promise<boolean> => {
      try {
        await send(false);
        out.push({ ok: true, text: label });
        return true;
      } catch (e) {
        const verdict = lockoutVerdictOf(e);
        if (verdict) {
          setLockout({
            verdict,
            retry: () => {
              setLockout(null);
              void send(true).then(() => { setNotes((n) => [...n, { ok: true, text: `${label} (confirmed)` }]); void refetch(); })
                .catch((err) => setNotes((n) => [...n, { ok: false, text: `${label}: ${errText(err)}` }]));
            },
          });
          out.push({ ok: false, text: `${label}: waiting for you to confirm` });
          return false;
        }
        out.push({ ok: false, text: `${label}: ${errText(e)}` });
        return true;
      }
    };
    for (const list of adds) {
      const go = await step(`Added to ${list}`, (confirm) => devicesApi.addAddressListEntry(deviceId, {
        list, address, comment: clientName ? clientName.slice(0, 100) : undefined, ...(confirm ? { confirm_lockout: true } : {}),
      }));
      if (!go) break;
    }
    for (const m of removes) {
      const go = await step(`Removed from ${m.list}`, (confirm) => devicesApi.removeAddressListEntry(deviceId, m.id, confirm));
      if (!go) break;
    }
    setNotes(out);
    setBusy(false);
    setWanted(null);
    setNewList('');
    void refetch();
    void qc.invalidateQueries({ queryKey: ['address-lists', deviceId] });
  };

  const dirty = !!view && (newList.trim() !== '' || (wanted !== null &&
    (wanted.size !== memberOf(view).size || [...wanted].some((l) => !memberOf(view).has(l)))));
  const deviceName = choices.find((d) => d.id === deviceId)?.name ?? '';

  return (
    <FloatingWindow
      title={`Address lists · ${clientName || address}`}
      icon={<ListChecks className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent)' }} />}
      onClose={onClose}
      width={520}
      height={600}
    >
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-gray-500 dark:text-slate-400">On</span>
          <select className="input py-1 text-sm flex-1" value={deviceId ?? ''}
            onChange={(e) => { setPicked(Number(e.target.value)); setWanted(null); setNotes([]); }}>
            {choices.map((d) => <option key={d.id} value={d.id}>{d.name.trim()}{d.device_type === 'router' ? '' : ` (${d.device_type})`}</option>)}
          </select>
        </div>
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Address <span className="font-mono">{address}</span>. Tick the lists it should be in; an address can be in several.
        </p>

        {view?.lease && !view.lease.static && (
          <div className="flex gap-2 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-800 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              This is a dynamic DHCP lease on {deviceName}. If the client gets a different address, these lists keep the old one
              and whoever gets it next is treated the same. Make the lease static on the DHCP page to keep them together.
            </span>
          </div>
        )}

        {isLoading && <p className="text-gray-400">Reading address lists…</p>}
        {isError && <p className="text-red-600 dark:text-red-400 text-xs">{errText(error)}</p>}
        {view && (
          <>
            {view.lists.length === 0 && <p className="text-xs text-gray-500 dark:text-slate-400">No address lists on {deviceName} yet.</p>}
            <div className="rounded-lg border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-700 max-h-72 overflow-y-auto">
              {view.lists.map((list) => {
                const m = view.member.find((x) => x.list === list);
                const locked = !!m?.dynamic;
                return (
                  <label key={list} className={clsx('flex items-center gap-2 px-3 py-2', locked ? 'opacity-60' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700/30')}
                    title={locked ? 'Added by a firewall rule; it can only change on the router' : undefined}>
                    <input type="checkbox" className="w-4 h-4 rounded" checked={current.has(list)} disabled={locked || busy} onChange={() => toggle(list)} />
                    <span className="font-mono text-xs flex-1">{list}</span>
                    {view.referenced.includes(list) && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400" title="A firewall rule matches on this list; Change Guard checks the change first">
                        <ShieldAlert className="w-3 h-3" />used by rules
                      </span>
                    )}
                    {locked && <span className="text-[11px] text-gray-400">dynamic{m?.timeout ? ` · ${m.timeout}` : ''}</span>}
                  </label>
                );
              })}
            </div>
            <label className="flex items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-slate-400 flex-shrink-0">Add to a new list</span>
              <input className="input py-1 text-xs font-mono flex-1" value={newList} disabled={busy}
                onChange={(e) => setNewList(e.target.value.replace(/\s/g, ''))} placeholder="list name" maxLength={63} />
            </label>
            <div className="flex items-center gap-3">
              <button className="btn-primary text-sm" disabled={!dirty || busy} onClick={() => { void apply(); }}>
                {busy ? 'Applying…' : 'Apply'}
              </button>
              {dirty && !busy && <button className="text-sm text-gray-500 hover:underline" onClick={() => { setWanted(null); setNewList(''); }}>Undo</button>}
            </div>
            {notes.length > 0 && (
              <div className="space-y-0.5">
                {notes.map((n, i) => (
                  <p key={i} className={clsx('text-xs', n.ok ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400')}>{n.text}</p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {lockout && deviceId !== null && (
        <LockoutVerdictDialog deviceId={deviceId} verdict={lockout.verdict} confirmPhrase={deviceName || 'confirm'}
          onConfirm={lockout.retry} onCancel={() => setLockout(null)} />
      )}
    </FloatingWindow>
  );
}

const errText = (e: unknown) =>
  (e as { response?: { data?: { error?: string; reason?: string } } })?.response?.data?.error
  || (e as { response?: { data?: { reason?: string } } })?.response?.data?.reason
  || (e as Error)?.message || 'That didn’t work';
