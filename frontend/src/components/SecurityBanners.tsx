import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { authApi } from '../services/api';

interface SecurityStatus {
  warnings: string[];
}

export default function SecurityBanners() {
  const [status, setStatus] = useState<SecurityStatus | null>(null);

  useEffect(() => {
    authApi.securityStatus()
      .then((r) => setStatus(r.data))
      .catch(() => {});
  }, []);

  const noWarnings = !status || status.warnings.length === 0;
  if (noWarnings) return null;

  const hasSecretsNotPersisted = !!status && status.warnings.includes('secrets_not_persisted');
  const hasAdminWarning = !!status && status.warnings.includes('admin_password_default');
  const hasKeyMissing = !!status && status.warnings.includes('encryption_key_missing');

  return (
    <div>
      {hasKeyMissing && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-4 py-2 text-sm text-red-800 dark:text-red-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            <span className="font-semibold">Encryption key missing:</span>{' '}
            stored device passwords can&apos;t be decrypted, so devices can&apos;t be reached and new credentials
            can&apos;t be saved. Restore <code>secrets.json</code> to the <code>app_data</code> volume, or set{' '}
            <code>ENCRYPTION_KEY</code> (or <code>ENCRYPTION_KEY_PREVIOUS</code>) to the original key, then restart.
            Don&apos;t re-enter credentials first: they would be saved under the wrong key.
          </span>
        </div>
      )}
      {hasSecretsNotPersisted && (
        <div className="flex items-center gap-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2 text-sm text-yellow-800 dark:text-yellow-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            <span className="font-semibold">Security warning:</span>{' '}
            Auto-generated secrets could not be saved, so they will change on
            every restart — logging users out and potentially orphaning stored
            device credentials. Mount a writable volume at{' '}
            <code className="font-mono text-xs">SECRETS_DIR</code> (default{' '}
            <code className="font-mono text-xs">/app/data</code>) or set{' '}
            <code className="font-mono text-xs">JWT_SECRET</code> and{' '}
            <code className="font-mono text-xs">ENCRYPTION_KEY</code> in your{' '}
            <code className="font-mono text-xs">.env</code>.
          </span>
        </div>
      )}
      {hasAdminWarning && (
        <div className="flex items-center justify-between gap-4 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-4 py-2 text-sm text-red-800 dark:text-red-200">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>
              <span className="font-semibold">Critical:</span> The{' '}
              <code className="font-mono text-xs">admin</code> account is
              using the default password. Change it immediately.
            </span>
          </div>
          <Link
            to="/settings"
            className="shrink-0 bg-red-600 hover:bg-red-700 text-white text-xs px-3 py-1 rounded font-medium"
          >
            Change password
          </Link>
        </div>
      )}
    </div>
  );
}
