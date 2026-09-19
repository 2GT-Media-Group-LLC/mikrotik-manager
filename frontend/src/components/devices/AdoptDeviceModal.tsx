import { useState, useMemo, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X, ShieldQuestion, Check, AlertTriangle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import {
  adoptionApi,
  type AdoptionCandidate, type AdoptionResult, type AddressPlan,
} from '../../services/api';

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
  const [addrMode, setAddrMode] = useState<'dhcp' | 'static'>('static');
  const [targetAddress, setTargetAddress] = useState('');
  const [prefix, setPrefix] = useState('24');
  const [gatewayInput, setGatewayInput] = useState('');
  const [vlanId, setVlanId] = useState('');
  const [addrCheck, setAddrCheck] = useState<{ free: boolean; reason?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [removeFactoryAddress, setRemoveFactoryAddress] = useState(true);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<AdoptionResult | null>(null);

  const rec = candidate.recommendation;
  // The server checks this again properly once authenticated; this is only so
  // the operator is not surprised by a refusal they could have seen coming.
  const looksEstablished = rec?.mode === 'add';

  const jumpHost = candidate.seenBy.find((h) => h.id === jumpHostId);

  // The jump host's subnet is offered as a *starting point* only. It is not
  // assumed: plenty of networks are not /24 and plenty of gateways are not .1,
  // and a management interface often belongs on its own VLAN. Everything here
  // is editable.
  const subnet = useMemo(
    () => (jumpHost?.ip_address || '').split('.').slice(0, 3).join('.'),
    [jumpHost]
  );

  const plan: AddressPlan = addrMode === 'dhcp'
    ? { mode: 'dhcp', ...(vlanId ? { vlanId: Number(vlanId) } : {}) }
    : {
        mode: 'static',
        address: targetAddress,
        prefix: Number(prefix) || 24,
        gateway: gatewayInput,
        ...(vlanId ? { vlanId: Number(vlanId) } : {}),
      };

  // Checked against the network before anything is written, so a clash surfaces
  // in the form rather than as a refusal part-way through adoption.
  useEffect(() => {
    let cancelled = false;
    const applicable =
      addrMode === 'static' && /^\d{1,3}(\.\d{1,3}){3}$/.test(targetAddress) && !!jumpHostId;

    // Every state update happens inside the timer. Doing any of it in the
    // effect body synchronously triggers a cascading render, and the debounce
    // is wanted regardless so the check does not fire on each keystroke.
    const t = setTimeout(() => {
      if (cancelled) return;
      if (!applicable) { setAddrCheck(null); return; }
      setChecking(true);
      adoptionApi.checkAddress(jumpHostId, targetAddress)
        .then((r) => { if (!cancelled) setAddrCheck(r.data); })
        .catch(() => { if (!cancelled) setAddrCheck(null); })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, applicable ? 600 : 0);

    return () => { cancelled = true; clearTimeout(t); };
  }, [targetAddress, jumpHostId, addrMode]);

  const adopt = useMutation({
    mutationFn: () =>
      adoptionApi
        .adopt({
          mac: candidate.mac,
          jumpHostId,
          plan,
          password,
          identity: name.trim() || undefined,
          name: name.trim() || undefined,
          removeFactoryAddress,
          force: force || undefined,
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

  const staticReady = /^\d{1,3}(\.\d{1,3}){3}$/.test(targetAddress)
    && /^\d{1,3}(\.\d{1,3}){3}$/.test(gatewayInput)
    && addrCheck?.free !== false
    && !checking;
  const ready = !!jumpHostId && password.length > 0 && !adopt.isPending
    && (addrMode === 'dhcp' || staticReady)
    && (!looksEstablished || force);

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
          {looksEstablished ? (
            // The scenario this guard exists for: a switch that is already in
            // service, often simply on a subnet we do not route to. Adoption
            // would rewrite addressing it is currently using.
            <div className="rounded p-3 text-[12px] bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-px shrink-0" />
                <div className="space-y-1.5">
                  <p className="font-medium">This device looks like it is already configured.</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {rec.reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                  <p>
                    Adoption is for devices straight out of the box. Running it here would add an address and
                    change the identity of a device that is already in use. If you just need it in the manager,
                    close this and use <span className="font-medium">Add to Manager</span> with its credentials.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <p className="text-[13px] text-gray-600 dark:text-slate-300 leading-relaxed">
                This device is on the factory address <span className="mono">{candidate.address}</span> with no
                route to your network, so it cannot be added directly. A managed neighbour will be borrowed
                briefly to give it an address here, then returned to exactly how it was.
              </p>
              {rec && (
                <p className="text-[11px] text-gray-400">
                  {rec.confidence === 'low' ? 'Best guess — ' : 'Detected as new — '}
                  {rec.reasons.join('; ')}.
                </p>
              )}
            </>
          )}

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

          <div className="border border-gray-200 dark:border-slate-700 rounded p-3 space-y-3">
            <div className="flex items-center gap-4">
              <span className="text-xs font-medium text-gray-700 dark:text-slate-300">Management address</span>
              {(['static', 'dhcp'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                  <input
                    type="radio" name="addrMode" checked={addrMode === m}
                    onChange={() => setAddrMode(m)}
                  />
                  {m === 'static' ? 'Static' : 'DHCP'}
                </label>
              ))}
            </div>

            {addrMode === 'static' ? (
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-[11px] text-gray-500 mb-1">Address</label>
                  <input
                    className="input w-full mono" value={targetAddress}
                    onChange={(e) => setTargetAddress(e.target.value)}
                    placeholder={subnet ? `${subnet}.60` : '10.0.0.10'}
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">Prefix</label>
                  <input
                    className="input w-full mono" value={prefix}
                    onChange={(e) => setPrefix(e.target.value.replace(/\D/g, ''))}
                    placeholder="24"
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-[11px] text-gray-500 mb-1">Gateway</label>
                  <input
                    className="input w-full mono" value={gatewayInput}
                    onChange={(e) => setGatewayInput(e.target.value)}
                    placeholder={subnet ? `${subnet}.1` : '10.0.0.1'}
                  />
                  <p className="text-[10.5px] text-gray-400 mt-1">
                    Not assumed — it is often not .1, and the device cannot reply off-subnet without it.
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-[11.5px] text-gray-500 dark:text-slate-400">
                A DHCP client is added and the lease read back to learn where the device landed.
                Consider a reservation, so infrastructure keeps a stable address.
              </p>
            )}

            <div>
              <label className="block text-[11px] text-gray-500 mb-1">Management VLAN (optional)</label>
              <input
                className="input w-full mono" value={vlanId}
                onChange={(e) => setVlanId(e.target.value.replace(/\D/g, ''))}
                placeholder="leave blank for the untagged bridge"
              />
              {vlanId && (
                <p className="text-[10.5px] text-amber-600 mt-1">
                  A <span className="mono">bridge-vlan{vlanId}</span> interface will be created and addressed.
                  The uplink must already carry VLAN {vlanId} tagged — if it does not, adoption stops at
                  verification and the factory address is left in place.
                </p>
              )}
            </div>

            {addrMode === 'static' && (checking || addrCheck) && (
              <div className={clsx(
                'text-[11.5px] flex items-center gap-1.5',
                checking ? 'text-gray-400' : addrCheck?.free ? 'text-green-600' : 'text-red-600'
              )}>
                {checking
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> checking {targetAddress}…</>
                  : addrCheck?.free
                    ? <><Check className="w-3 h-3" /> {targetAddress} is free (no ARP entry, no ping reply)</>
                    : <><AlertTriangle className="w-3 h-3" /> {addrCheck?.reason}</>}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Name</label>
            <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" />
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

          {looksEstablished && (
            <label className="flex items-start gap-2 text-[12px] text-red-700 dark:text-red-300 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>
                I am sure this device is factory-default — configure it anyway
                <span className="block text-[11px] opacity-80">
                  The device is checked again after connecting, and adoption still stops if it disagrees.
                </span>
              </span>
            </label>
          )}

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
