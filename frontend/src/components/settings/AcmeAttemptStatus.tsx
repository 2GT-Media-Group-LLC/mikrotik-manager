import { useQuery } from '@tanstack/react-query';
import { certApi } from '../../services/api';
import { apiErrorMessage } from '../../utils/apiError';

export default function AcmeAttemptStatus() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cert-acme-status'],
    queryFn: () => certApi.getAcmeStatus().then((response) => response.data),
    refetchInterval: 5000,
  });
  const attempt = data?.lastAttempt;

  return (
    <div className="border-t border-gray-200 dark:border-slate-700 pt-3">
      <h4 className="text-sm font-medium text-gray-900 dark:text-white">Last Certbot attempt</h4>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Could not load Certbot status: {apiErrorMessage(error)}
        </p>
      ) : isLoading ? (
        <p className="text-sm text-gray-400">Loading Certbot status...</p>
      ) : !attempt ? (
        <p className="text-sm text-gray-500 dark:text-slate-400">No completed Certbot attempt.</p>
      ) : (
        <div className="mt-1 space-y-2">
          <p className={`text-sm ${attempt.exitCode === 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {attempt.action === 'issue' ? 'Certificate request' : 'Renewal check'} {attempt.exitCode === 0 ? 'succeeded' : `failed (exit code ${attempt.exitCode})`}
            {' '}for {attempt.domain} at {new Date(attempt.time).toLocaleString()}.
          </p>
          {attempt.output && (
            <details>
              <summary className="text-sm text-gray-600 dark:text-slate-300 cursor-pointer">Certbot output and log</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-100 dark:bg-slate-800 p-3 text-xs text-gray-700 dark:text-slate-200">{attempt.output}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
