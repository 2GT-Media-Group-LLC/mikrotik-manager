import { useState, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X, ShieldQuestion, Check, AlertTriangle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { adoptionApi, type AdoptionCandidate, type AdoptionResult } from '../../services/api';

/**
 * Adopting a factory-default MikroTik.
 *
 * A new device announces itself the moment it is plugged in, but sits on
 * 192.168.88.1 with no route off that subnet, so "Add to Manager" cannot reach
 * it. This borrows a managed neighbour to configure it instead.
 *
 * The password field has no default on purpose. Modern units ship with a unique
 * password printed on the device rather than a blank one, so there is nothing to
 * pre-fill and nothing to guess.
 */

interface Props {
  candidate: AdoptionCandidate;
  onClose: () => void;
  onSuccess: () => void;
}

export default function AdoptDeviceModal({ candidate, onClose, onSuccess }: Props) {
  const [jumpHostId, setJumpHostId] = useState(candidate.seenBy[0]?.id ?? 0);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [targetAddress, setTargetAddress] = useState('');
  const [removeFactoryAddress, setRemoveFactoryAddress] = useState(true);
  const [result, setResult] = useState<AdoptionResult | null>(null);

  const jumpHost = candidate.seenBy.find((h) => h.id === jumpHostId);

  // The device has to land on the jump host's subnet, so the gateway is derived
  // from it rather than asked for. Getting this wrong strands the device.
  const subnet = useMemo(
    () => (jumpHost?.ip_address || '').split('.').slice(0, 3).join('.'),
    [jumpHost]
  );
  const gateway = subnet ? `${subnet}.1` : '';

  const adopt = useMutation({
    mutationFn: () =>
      adoptionApi
        .adopt({
          mac: candidate.mac,
          jumpHostId,
          targetAddress,
          gateway,
          password,
          identity: name.trim() || undefined,
          name: name.trim() || undefined,
          removeFactoryAddress,
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      setResult(data);
      if (data.ok) setTimeout(onSuccess, 1800);
    },
    onError: (e: unknown) => {
      const msg =
        (e as { response?: { data?: AdoptionResult } })?.response?.data ??
        { ok: false, steps: [], error: e instanceof Error ? e.message : 'Adoption failed' };
      setResult(msg as AdoptionResult);
    },
  });

  const addressValid = /^\d{1,3}(\.\d{1,3}){3}$/.test(targetAddress)
    && targetAddress.startsWith(`${subnet}.`);
  const ready = !!jumpHostId && password.length > 0 && addressValid && !adopt.isPending;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <ShieldQuestion className="w-5 h-5 text-blue-500" />
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Adopt factory device</h2>
              <p className="text-xs text-gray-500 dark:text-slate-400 mono">
                {candidate.mac} · currently {candidate.address}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-[13px] text-gray-600 dark:text-slate-300 leading-relaxed">
            This device is on the factory address <span className="mono">{candidate.address}</span> with no route
            to your network, so it cannot be added directly. A managed neighbour will be borrowed briefly to give
            it an address here, then returned to exactly how it was.
          </p>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">
              Borrow which managed device?
            </label>
            <select className="input w-full" value={jumpHostId} onChange={(e) => setJumpHostId(Number(e.target.value))}>
              {candidate.seenBy.map((h) => (
                <option key={h.id} value={h.id}>{h.name} ({h.ip_address})</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              Any device that can see the new one. It gets a temporary second address for about a minute.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">
              Device password
            </label>
            <input
              type="password" className="input w-full" value={password} autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="printed on a sticker on the unit"
            />
            <p className="text-[11px] text-gray-400 mt-1">
              MikroTik ships every unit with its own password, printed on the device itself. There is no default.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">
                New address
              </label>
              <input
                className="input w-full mono" value={targetAddress}
                onChange={(e) => setTargetAddress(e.target.value)}
                placeholder={subnet ? `${subnet}.60` : '—'}
              />
              {targetAddress && !addressValid && (
                <p className="text-[11px] text-amber-600 mt-1">Must be a free address on {subnet}.0/24</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Name</label>
              <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" />
            </div>
          </div>

          <label className="flex items-start gap-2 text-[12px] text-gray-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox" className="mt-0.5" checked={removeFactoryAddress}
              onChange={(e) => setRemoveFactoryAddress(e.target.checked)}
            />
            <span>
              Remove the factory {candidate.address} address afterwards
              <span className="block text-[11px] text-gray-400">
                Recommended. Two un-adopted devices both answering on {candidate.address} would collide.
              </span>
            </span>
          </label>

          <div className="flex items-start gap-2 text-[11px] rounded p-2.5 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
            <span>
              The password is sent over plain HTTP to reach the device, because factory units have HTTPS
              disabled. It travels only between the borrowed neighbour and the new device on your local
              segment. Consider changing it after adoption.
            </span>
          </div>

          {result && (
            <div className="rounded border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-800">
              {result.steps.map((s, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                  {s.ok
                    ? <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
                    : <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                  <span className={clsx(s.ok ? 'text-gray-600 dark:text-slate-300' : 'text-red-600')}>
                    {s.step}{s.detail ? ` — ${s.detail}` : ''}
                  </span>
                </div>
              ))}
              {result.error && (
                <div className="px-3 py-2 text-[12px] text-red-600 dark:text-red-400">{result.error}</div>
              )}
              {result.ok && (
                <div className="px-3 py-2 text-[12px] text-green-600 dark:text-green-400">
                  Adopted. Opening the device list…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-200 dark:border-slate-700">
          <button onClick={onClose} className="btn-secondary text-[12px]">
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          {!result?.ok && (
            <button
              onClick={() => { setResult(null); adopt.mutate(); }}
              disabled={!ready}
              className="btn-primary text-[12px] flex items-center gap-2 disabled:opacity-50"
            >
              {adopt.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {adopt.isPending ? 'Adopting…' : 'Adopt device'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
