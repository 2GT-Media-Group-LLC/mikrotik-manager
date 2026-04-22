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

  if (!status || status.warnings.length === 0) return null;

  const hasSecretWarning =
    status.warnings.includes('jwt_secret_default') ||
    status.warnings.includes('encryption_key_default');
  const hasAdminWarning = status.warnings.includes('admin_password_default');

  const secretNames = [
    status.warnings.includes('jwt_secret_default') && 'JWT_SECRET',
    status.warnings.includes('encryption_key_default') && 'ENCRYPTION_KEY',
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    <div>
      {hasSecretWarning && (
        <div className="flex items-center gap-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2 text-sm text-yellow-800 dark:text-yellow-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            <span className="font-semibold">Security warning:</span>{' '}
            {secretNames}{' '}
            {status.warnings.filter((w) =>
              ['jwt_secret_default', 'encryption_key_default'].includes(w)
            ).length > 1
              ? 'are'
              : 'is'}{' '}
            using default values. Set strong secrets in your{' '}
            <code className="font-mono text-xs">.env</code> file before
            exposing this to any network.
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
