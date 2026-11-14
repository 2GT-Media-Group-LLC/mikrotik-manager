import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, wirelessApi, type CapsmanBand, type CapsmanFlavor, type CapsmanSetupInfo, type CapsmanSetupRequest } from '../../services/api';
import DevicePicker from '../common/DevicePicker';
import ReviewChangesButton from '../common/ReviewChangesButton';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import { capsmanCountryError, capsmanPassphraseError, capsmanSsidError } from '../../utils/capsmanSetup';

const errMsg = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error)?.message || 'That didn’t work';

const flavorLabel = (f: CapsmanFlavor) => (f === 'wifi'
  ? 'wifi (RouterOS 7 wifi package: ax and ac wave2 APs)'
  : 'legacy wireless (/caps-man: older APs on the wireless package)');
const bandLabel = (b: CapsmanBand) => (b === '2ghz' ? '2.4 GHz' : '5 GHz');
const stateOf = (d: CapsmanSetupInfo | undefined, f: CapsmanFlavor | null) => (f === 'wifi' ? d?.state.wifi : f === 'legacy' ? d?.state.legacy : undefined);

/**
 * CAPsMAN quick set (#438, from Ron): an SSID and a password, and a device
 * becomes a CAPsMAN controller, or a controller that serves its own radios too.
 */
export default function CapsmanSetupModal({ onClose, initialDeviceId }: { onClose: () => void; initialDeviceId?: number }) {
  const qc = useQueryClient();
  const guard = useGuardedWrite();
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: () => devicesApi.list().then((r) => r.data), staleTime: 60_000 });
  const [deviceId, setDeviceId] = useState<number | null>(initialDeviceId ?? null);
  const device = devices.find((d) => d.id === deviceId);
  const info = useQuery({
    queryKey: ['capsman-setup', deviceId],
    queryFn: () => wirelessApi.capsmanSetup(deviceId!).then((r) => r.data),
    enabled: deviceId != null,
    retry: false,
  });

  const [flavor, setFlavor] = useState<CapsmanFlavor | null>(null);
  const [ssid, setSsid] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [bridge, setBridge] = useState('');
  const [country, setCountry] = useState('');
  const [localRadios, setLocalRadios] = useState(true);
  const [band, setBand] = useState<CapsmanBand>('both');
  // Both bands, with 5 GHz on an SSID of its own (Ron, #438).
  const [split, setSplit] = useState(false);
  const [ssid5, setSsid5] = useState('');
  const [touched, setTouched] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');

  // A device's answer fills the form: its earlier setup, or sensible defaults.
  const [filledFrom, setFilledFrom] = useState<CapsmanSetupInfo | undefined>();
  if (info.data && info.data !== filledFrom) {
    const d = info.data;
    setFilledFrom(d);
    const s = stateOf(d, d.default_flavor);
    setFlavor(d.default_flavor);
    setSsid(s?.ssid ?? '');
    setPassphrase('');
    setBridge(s?.bridge ?? (d.bridges.includes('bridge') ? 'bridge' : d.bridges[0] ?? ''));
    setCountry(s?.country ?? '');
    setBand(s?.band ?? 'both');
    setSplit(!!s?.ssid5);
    setSsid5(s?.ssid5 ?? '');
    setLocalRadios(s ? (s.configured ? s.local_radios : s.radios.length > 0) : false);
    setTouched(false);
  }

  const st = stateOf(info.data, flavor);
  const radios = st?.radios ?? [];
  const splitOn = band === 'both' && split;
  // A wifi CAPsMAN can't serve its own radios through its own CAP, and the
  // only way RouterOS offers replaces the radios' own SSIDs, virtual APs
  // included, for good. So only legacy offers Controller and AP.
  const canServeOwn = flavor === 'legacy' && radios.length > 0;
  // A new 5 GHz configuration needs the password, even when the first keeps its own.
  const newSsid5 = splitOn && !st?.ssid5;
  const errors = {
    ssid: capsmanSsidError(ssid),
    ssid5: !splitOn ? null : capsmanSsidError(ssid5) ? 'Enter the 5 GHz SSID, or untick it.' : ssid5 === ssid ? 'Use a different name from the 2.4 GHz SSID, or untick it.' : null,
    passphrase: newSsid5 && !passphrase ? 'Enter the Wi-Fi password: the 5 GHz SSID is new.' : capsmanPassphraseError(passphrase, !!st?.configured),
    bridge: bridge ? null : 'Choose the bridge the Wi-Fi clients join.',
    country: capsmanCountryError(country),
  };
  const valid = !!flavor && Object.values(errors).every((e) => !e);

  const body = (): CapsmanSetupRequest => ({ flavor: flavor!, ssid, passphrase, bridge, country: country.trim(), localRadios: localRadios && canServeOwn, band, ...(splitOn ? { ssid5 } : {}) });
  const applyMut = useMutation({
    mutationFn: (confirm: boolean) => wirelessApi.applyCapsmanSetup(deviceId!, body(), confirm),
    onSuccess: (res) => {
      guard.onSuccess(res);
      setFailure('');
      setMessage([res.data.message, ...(res.data.warnings ?? [])].join(' '));
      qc.invalidateQueries({ queryKey: ['capsman-setup', deviceId] });
      qc.invalidateQueries({ queryKey: ['capsman'] });
    },
  });
  const fail = (e: unknown) => { setMessage(''); setFailure(errMsg(e)); };
  const apply = () => {
    setTouched(true);
    if (!valid) return;
    applyMut.mutate(false, { onError: guard.onError(() => applyMut.mutate(true, { onError: fail }), fail) });
  };

  // What the device will do differently, said before it's applied.
  const notes: string[] = [];
  if (st && localRadios && canServeOwn && !st.local_radios) {
    notes.push(band === 'both'
      ? `Its own radios (${radios.join(', ')}) switch to ${ssid || 'this SSID'}. Clients on their current networks reconnect to it.`
      : `Its own ${bandLabel(band)} radios switch to ${ssid || 'this SSID'}. Clients on their current networks reconnect to it.`);
  }
  if (st && (!localRadios || !canServeOwn) && st.local_radios) {
    notes.push(flavor === 'wifi'
      ? 'Its own CAP, pointed at itself, is turned off. On wifi it never served the radios, so they don’t change.'
      : 'Its own radios stop taking the controller’s SSID and go back to their own settings.');
  }
  if (splitOn) {
    notes.push(`2.4 GHz radios take ${ssid || 'the first SSID'} and 5 GHz radios take ${ssid5 || 'the second'}, with the same password.`);
  }
  if (st?.ssid5 && !splitOn) notes.push(`${st.ssid5} goes: ${band === 'both' ? 'every radio' : `${bandLabel(band)} radios`} take ${ssid || 'this SSID'}.`);
  if (st?.other_rules && splitOn) {
    notes.push(`Both rules go before the device’s own ${st.other_rules === 1 ? 'rule' : 'rules'}.`);
  } else if (st?.other_rules && band === 'both') {
    notes.push(`The device already has ${st.other_rules === 1 ? 'a provisioning rule' : `${st.other_rules} provisioning rules`} of its own. `
      + 'RouterOS uses the first rule that matches a radio, so radios those match keep their configuration.');
  } else if (st?.other_rules) {
    notes.push(`This rule goes before the device’s own ${st.other_rules === 1 ? 'rule' : 'rules'}: ${bandLabel(band)} radios take ${ssid || 'this SSID'}, `
      + `and the other band’s radios keep matching ${st.other_rules === 1 ? 'it' : 'them'}.`);
  }

  const field = (error: string | null) => touched && error
    ? <p className="text-[11px] text-red-600 dark:text-red-400 mt-1">{error}</p> : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Set up CAPsMAN</h2>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Makes a device a CAPsMAN controller with one SSID, on both bands or one. Access points that join it get the SSID and password
            from the controller. Running this again on the same device changes the same setup.
          </p>

          <div>
            <label className="label">Controller</label>
            <DevicePicker devices={devices} value={deviceId} onChange={(id) => { setDeviceId(id); setMessage(''); setFailure(''); }}
              placeholder="Choose the device to be the controller" />
          </div>

          {deviceId != null && info.isLoading && (
            <p className="text-xs text-gray-500 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading {device?.name ?? 'the device'}…</p>
          )}
          {info.error && <p className="text-xs text-red-600 dark:text-red-400">{errMsg(info.error)}</p>}
          {info.data && !info.data.flavors.length && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {device?.name ?? 'This device'} has no CAPsMAN: it needs RouterOS 7.13 or later, or the legacy wireless package.
            </p>
          )}

          {info.data && flavor && <>
            {info.data.flavors.length > 1 && (
              <div>
                <label className="label">CAPsMAN</label>
                <select className="input" value={flavor} onChange={(e) => {
                  const f = e.target.value as CapsmanFlavor;
                  setFlavor(f);
                  const s = stateOf(info.data, f);
                  setLocalRadios(s ? (s.configured ? s.local_radios : s.radios.length > 0) : false);
                  setBand(s?.band ?? 'both'); setSplit(!!s?.ssid5); setSsid5(s?.ssid5 ?? '');
                }}>
                  {info.data.flavors.map((f) => <option key={f} value={f}>{flavorLabel(f)}</option>)}
                </select>
                <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-1">A wifi controller can&rsquo;t manage legacy APs, and a legacy one can&rsquo;t manage wifi APs.</p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">{splitOn ? 'SSID (2.4 GHz)' : 'SSID'}</label>
                <input className="input" value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} />
                {field(errors.ssid)}
              </div>
              <div>
                <label className="label">Password</label>
                <input className="input" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={st?.configured ? 'Leave empty to keep it' : '8 to 63 characters'} />
                {field(errors.passphrase)}
              </div>
              <div>
                <label className="label">Bridge</label>
                <select className="input" value={bridge} onChange={(e) => setBridge(e.target.value)}>
                  {!bridge && <option value="">Choose a bridge</option>}
                  {info.data.bridges.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                {field(errors.bridge)}
                <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-1">Wi-Fi clients join it, on the controller and on every AP (each AP needs a bridge with this name).</p>
              </div>
              <div>
                <label className="label">Country (optional)</label>
                <input className="input" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. united states" />
                {field(errors.country)}
              </div>
              <div>
                <label className="label">Radios</label>
                <select className="input" value={band} onChange={(e) => setBand(e.target.value as CapsmanBand)}>
                  <option value="both">2.4 GHz and 5 GHz</option>
                  <option value="2ghz">2.4 GHz only</option>
                  <option value="5ghz">5 GHz only</option>
                </select>
                <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-1">
                  {splitOn ? '2.4 GHz radios get the first SSID, 5 GHz radios the second.'
                    : band === 'both' ? 'Every radio that joins gets this SSID.' : `Only ${bandLabel(band)} radios get this SSID; the other band’s are left as they are.`}
                </p>
                {band === 'both' && (
                  <label className="flex items-center gap-2 text-sm mt-2">
                    <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                    A different SSID on 5 GHz
                  </label>
                )}
              </div>
              {splitOn && (
                <div>
                  <label className="label">SSID (5 GHz)</label>
                  <input className="input" value={ssid5} onChange={(e) => setSsid5(e.target.value)} maxLength={32} />
                  {field(errors.ssid5)}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="label">Role</label>
              <label className={clsx('flex items-start gap-2 text-sm', !canServeOwn && 'opacity-50')}>
                <input type="radio" className="mt-1" checked={localRadios && canServeOwn} disabled={!canServeOwn} onChange={() => setLocalRadios(true)} />
                <span>Controller and AP
                  <span className="block text-[11px] text-gray-500 dark:text-slate-400">
                    {canServeOwn ? `Its own radios (${radios.join(', ')}) broadcast the SSID too.`
                      : flavor === 'wifi' && radios.length
                        ? 'Not on wifi CAPsMAN: RouterOS can only hand a controller’s own radios to it by replacing their own SSIDs and virtual APs. To put them on this SSID, set them by hand.'
                        : 'This device has no radios of its own for this CAPsMAN.'}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" className="mt-1" checked={!localRadios || !canServeOwn} onChange={() => setLocalRadios(false)} />
                <span>Controller only
                  <span className="block text-[11px] text-gray-500 dark:text-slate-400">It only manages the APs that join it.</span>
                </span>
              </label>
            </div>

            {notes.map((n) => (
              <p key={n} className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{n}</p>
            ))}
            <p className="text-[11px] text-gray-500 dark:text-slate-400">
              Other APs join by turning on their CAP (in Winbox: Wireless or WiFi → CAP) with discovery on the same network.
            </p>

            {message && <p className="text-xs text-green-600 dark:text-green-400">{message}</p>}
            {failure && <p className="text-xs text-red-600 dark:text-red-400">{failure}</p>}
            <GuardedWriteUi state={guard} deviceId={deviceId!} deviceName={device?.name} pending={applyMut.isPending} />

            <div className="flex items-center gap-2 flex-wrap">
              <button className="btn-primary text-sm" onClick={apply} disabled={applyMut.isPending}>
                {applyMut.isPending ? 'Applying…' : st?.configured ? 'Apply' : 'Set up CAPsMAN'}
              </button>
              <ReviewChangesButton className="text-sm" deviceName={device?.name} applyLabel="Set up CAPsMAN" onApply={apply}
                disabled={applyMut.isPending || !valid} request={() => wirelessApi.applyCapsmanSetup(deviceId!, body())} />
              <button className="btn-secondary text-sm ml-auto" onClick={onClose}>Close</button>
            </div>
          </>}
        </div>
      </div>
    </div>
  );
}
