import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { sshKeyApi } from '../../services/api';

/**
 * Per-device SSH key management.
 *
 * The warning about password SSH is not boilerplate. RouterOS refuses password
 * authentication for a user once a key is bound to them — verified on hardware —
 * so installing a key is a real trade, not a pure addition, and the operator has
 * to be told before they make it rather than after (#110).
 */
export default function SshKeyCard({ deviceId }: { deviceId: number }) {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['ssh-key', deviceId],
    queryFn: () => sshKeyApi.get(deviceId).then(r => r.data.key),
  });

  const run = (fn: () => Promise<{ data: { message: string } }>) => ({
    mutationFn: fn,
    onSuccess: (r: { data: { message: string } }) => {
      setMsg({ ok: true, text: r.data.message });
      setConfirmRevoke(false);
      queryClient.invalidateQueries({ queryKey: ['ssh-key', deviceId] });
    },
    onError: (e: unknown) => setMsg({
      ok: false,
      text: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Request failed',
    }),
  });

  const deploy = useMutation(run(() => sshKeyApi.deploy(deviceId, false)));
  const rotate = useMutation(run(() => sshKeyApi.deploy(deviceId, true)));
  const verify = useMutation(run(() => sshKeyApi.verify(deviceId)));
  const revoke = useMutation(run(() => sshKeyApi.revoke(deviceId)));
  const busy = deploy.isPending || rotate.isPending || verify.isPending || revoke.isPending;

  if (isLoading) return <div className="text-sm text-gray-500 dark:text-slate-400">Loading key status…</div>;

  const verified = data?.status === 'verified';

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <KeyRound className="w-5 h-5 mt-0.5 text-gray-400 dark:text-slate-500" />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900 dark:text-white">SSH key</h3>
            {data && (
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                verified
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                {data.status}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-600 dark:text-slate-300 mt-0.5">
            A unique keypair for this device, used for backups and config export instead of a
            stored password. The private half never leaves the server and is never shown.
          </p>
        </div>
      </div>

      {data ? (
        <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 text-xs space-y-1">
          <div className="flex gap-2">
            <span className="text-gray-500 dark:text-slate-400 w-24 shrink-0">Fingerprint</span>
            <span className="font-mono text-gray-900 dark:text-white break-all">{data.fingerprint}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 dark:text-slate-400 w-24 shrink-0">User</span>
            <span className="text-gray-900 dark:text-white">{data.ssh_username}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 dark:text-slate-400 w-24 shrink-0">Last proved</span>
            <span className="text-gray-900 dark:text-white">
              {data.last_verified_at ? new Date(data.last_verified_at).toLocaleString() : 'never'}
            </span>
          </div>
          {data.last_error && (
            <div className="flex gap-2">
              <span className="text-gray-500 dark:text-slate-400 w-24 shrink-0">Last error</span>
              <span className="text-red-600 dark:text-red-400 break-words">{data.last_error}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700/60 dark:bg-amber-900/20">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div className="text-amber-800 dark:text-amber-300">
            <span className="font-medium">Installing a key disables password SSH for this user.</span>{' '}
            RouterOS requires key authentication once a key is bound to an account. The binary API and
            WinBox are unaffected, and revoking the key restores password SSH.
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!data && (
          <button className="btn-primary text-xs flex items-center gap-1.5"
                  onClick={() => deploy.mutate()} disabled={busy}>
            {deploy.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            Install key
          </button>
        )}
        {data && (
          <>
            <button className="btn-secondary text-xs flex items-center gap-1.5"
                    onClick={() => verify.mutate()} disabled={busy}>
              <ShieldCheck className="w-3.5 h-3.5" /> Test
            </button>
            <button className="btn-secondary text-xs flex items-center gap-1.5"
                    onClick={() => rotate.mutate()} disabled={busy}>
              {rotate.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Rotate
            </button>
            {confirmRevoke ? (
              <>
                <button className="btn-danger text-xs" onClick={() => revoke.mutate()} disabled={busy}>
                  Confirm revoke
                </button>
                <button className="btn-secondary text-xs" onClick={() => setConfirmRevoke(false)}>Cancel</button>
              </>
            ) : (
              <button className="btn-secondary text-xs flex items-center gap-1.5 ml-auto"
                      onClick={() => setConfirmRevoke(true)} disabled={busy}>
                <Trash2 className="w-3.5 h-3.5" /> Revoke
              </button>
            )}
          </>
        )}
      </div>

      {msg && (
        <p className={`text-xs ${msg.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
