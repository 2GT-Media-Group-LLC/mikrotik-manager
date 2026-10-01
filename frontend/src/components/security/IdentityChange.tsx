import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, RefreshCw, Check } from 'lucide-react';
import { identityApi, type IdentityPin } from '../../services/api';
import { useAuthStore } from '../../store/authStore';

/**
 * A device's certificate or SSH host key changed since the manager pinned it
 * (outside review P1-4), so the manager stopped connecting before sending its
 * login. Shows both fingerprints, how to check the new one on the device, and,
 * for an admin, the button that accepts it.
 */
function ChangeDetails({ pin, deviceId, deviceName }: { pin: IdentityPin; deviceId: number; deviceName: string }) {
  const qc = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [confirming, setConfirming] = useState(false);
  const isCert = pin.kind === 'api-tls';
  const isSerial = pin.kind === 'serial';
  const noun = isCert ? 'certificate' : 'host key';

  const trust = useMutation({
    mutationFn: () => identityApi.trust(deviceId, pin.kind),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['identity', deviceId] });
      void qc.invalidateQueries({ queryKey: ['identity-pending'] });
    },
  });

  return (
    <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-900 dark:text-red-200 space-y-2">
      <div className="flex items-start gap-2">
        <ShieldAlert className="w-5 h-5 flex-shrink-0 text-red-600 dark:text-red-400" />
        <div className="flex-1">
          <p className="font-semibold">
            {isSerial ? `A different device is answering at ${deviceName}'s address` : `${deviceName}'s ${pin.label} has changed`}
            {pin.mismatch_at ? ` (seen ${new Date(pin.mismatch_at).toLocaleString()})` : ''}
          </p>
          {isSerial ? (
            <p className="mt-1 text-red-800 dark:text-red-300">
              It reports a different serial number, so the manager stopped polling it before reading or changing
              anything, and backups, commands and firmware for {deviceName} won&apos;t run on it. If {deviceName} was
              replaced, accept the new device. If two devices swapped addresses (DHCP), correct the address in
              Edit Device instead.
            </p>
          ) : (
            <p className="mt-1 text-red-800 dark:text-red-300">
              The manager stopped connecting to it over {isCert ? 'API-SSL' : 'SSH'} before sending its login, because
              it no longer presents the {noun} the manager first saw. That is expected after a reset or a replaced {noun}.
              It is also what someone posing as the device would look like, so check it before trusting it.
            </p>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono break-all">
        <dt className="font-sans text-red-700 dark:text-red-400">{isSerial ? 'On record' : 'Trusted'}</dt><dd>{pin.display}</dd>
        <dt className="font-sans text-red-700 dark:text-red-400">{isSerial ? 'Now reports' : 'Now presents'}</dt><dd className="font-semibold">{pin.seen_display}</dd>
      </dl>
      <p className="text-xs text-red-800 dark:text-red-300">
        {isSerial
          ? <>To check: the serial number is on the device&apos;s label, and in <strong>System → RouterBOARD</strong>.</>
          : isCert
          ? <>To check: on the device, <strong>System → Certificates</strong>, open the certificate the api-ssl service uses and compare its <strong>Fingerprint</strong>.</>
          : <>To check: from a computer on a network you trust, run <code className="px-1 bg-red-100 dark:bg-red-900/40 rounded">ssh-keyscan -p PORT ADDRESS | ssh-keygen -lf -</code> and compare.</>}
      </p>
      {isAdmin ? (
        confirming ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs">{isSerial ? `Make this device ${deviceName} from now on?` : `Trust this new ${noun} for ${deviceName}?`}</span>
            <button onClick={() => trust.mutate()} disabled={trust.isPending}
              className="px-3 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-medium flex items-center gap-1.5 disabled:opacity-50">
              {trust.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Yes, trust it
            </button>
            <button onClick={() => setConfirming(false)} className="btn-secondary text-xs py-1">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="btn-secondary text-xs py-1">{isSerial ? 'This is the new device' : `Trust new ${noun}`}</button>
        )
      ) : (
        <p className="text-xs italic">{isSerial ? 'An admin has to accept the new device.' : `An admin has to trust the new ${noun}.`}</p>
      )}
      {trust.isError && (
        <p className="text-xs text-red-700">{(trust.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not trust it'}</p>
      )}
    </div>
  );
}

/** Banner for the device page: shown only while a change waits. */
export function DeviceIdentityBanner({ deviceId, deviceName }: { deviceId: number; deviceName: string }) {
  const { data: pins = [] } = useQuery({
    queryKey: ['identity', deviceId],
    queryFn: () => identityApi.forDevice(deviceId).then((r) => r.data),
    refetchInterval: 60_000,
  });
  const changed = pins.filter((p) => p.seen_fingerprint);
  if (changed.length === 0) return null;
  return (
    <div className="space-y-2">
      {changed.map((p) => <ChangeDetails key={p.kind} pin={p} deviceId={deviceId} deviceName={deviceName} />)}
    </div>
  );
}

/** Card for the Security page: every device with a change waiting. */
export function PendingIdentityCard() {
  const { data: pending = [] } = useQuery({
    queryKey: ['identity-pending'],
    queryFn: () => identityApi.pending().then((r) => r.data),
    refetchInterval: 60_000,
  });
  if (pending.length === 0) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-red-700 dark:text-red-400 flex items-center gap-2">
        <ShieldAlert className="w-4 h-4" /> {pending.length} device{pending.length === 1 ? '' : 's'} with a changed certificate, host key or serial number
      </h2>
      {pending.map((p) => (
        <ChangeDetails key={`${p.device_id}-${p.kind}`} pin={p} deviceId={p.device_id} deviceName={p.device_name} />
      ))}
    </div>
  );
}
