import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { certApi } from '../../services/api';
import { apiErrorMessage } from '../../utils/apiError';

export default function AcmeCaBundleCard() {
  const queryClient = useQueryClient();
  const [certificate, setCertificate] = useState('');
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['cert-acme-ca-bundle'],
    queryFn: () => certApi.getAcmeCaBundle().then((r) => r.data),
  });
  const change = useMutation({
    mutationFn: async (pem: string | null) => {
      if (pem === null) return certApi.deleteAcmeCaBundle();
      if (new TextEncoder().encode(pem).length > 1024 * 1024) throw new Error('The CA bundle must be no larger than 1 MB.');
      return certApi.uploadAcmeCaBundle(pem);
    },
    onSuccess: (_response, pem) => {
      void queryClient.invalidateQueries({ queryKey: ['cert-acme-ca-bundle'] });
      setCertificate('');
      setMessage({ error: false, text: pem !== null ? 'ACME CA bundle installed.' : 'ACME CA bundle removed.' });
    },
    onError: (err) => setMessage({ error: true, text: apiErrorMessage(err, 'Could not update the ACME CA bundle.') }),
  });

  return (
    <div className="card p-5 space-y-3">
      <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
        <Upload className="w-4 h-4 text-blue-500" /> ACME Server CA Bundle
      </h3>
      <p className="text-xs text-gray-500 dark:text-slate-400">
        Optional PEM certificates for verifying a private ACME server. This replaces Certbot&apos;s default
        trust store, so include every CA needed by the ACME server. Paste PEM certificates or load them
        from a file. Do not upload a private key.
      </p>
      {isLoading ? (
        <p className="text-sm text-gray-400">Checking CA bundle...</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Could not check the ACME CA bundle: {apiErrorMessage(error)}
        </p>
      ) : data && (
        <>
          <p className="text-sm text-gray-600 dark:text-slate-300">
            {data.installed ? 'A custom ACME CA bundle is installed.' : 'No custom ACME CA bundle is installed.'}
          </p>
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="acme-ca-bundle" className="label mb-0">CA bundle (PEM)</label>
                <button type="button" className="text-xs text-blue-500 hover:text-blue-600 disabled:opacity-50"
                  disabled={change.isPending || reading} onClick={() => fileRef.current?.click()}>
                  Load from file...
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pem,.crt,.cer"
                  className="hidden"
                  disabled={change.isPending || reading}
                  onChange={async (e) => {
                    const selected = e.target.files?.[0];
                    e.target.value = '';
                    if (!selected) return;
                    setCertificate('');
                    setMessage(null);
                    setReading(true);
                    try {
                      if (selected.size > 1024 * 1024) throw new Error('The CA bundle must be no larger than 1 MB.');
                      setCertificate(await selected.text());
                    } catch (err) {
                      setMessage({ error: true, text: apiErrorMessage(err, 'Could not read the CA bundle.') });
                    } finally {
                      setReading(false);
                    }
                  }}
                />
              </div>
              <textarea
                id="acme-ca-bundle"
                className="input font-mono text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                rows={6}
                value={certificate}
                onChange={(e) => { setCertificate(e.target.value); setMessage(null); }}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                spellCheck={false}
                disabled={change.isPending || reading}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary disabled:opacity-50" disabled={!certificate.trim() || change.isPending || reading}
                onClick={() => { setMessage(null); change.mutate(certificate); }}>
                {data.installed ? 'Replace CA Bundle' : 'Upload CA Bundle'}
              </button>
              {data.installed && (
                <button type="button" className="btn-secondary disabled:opacity-50" disabled={change.isPending || reading}
                  onClick={() => {
                    if (confirm('Remove the ACME CA bundle and restore Certbot’s default trust store?')) {
                      setMessage(null);
                      change.mutate(null);
                    }
                  }}>
                  Remove CA Bundle
                </button>
              )}
            </div>
          </div>
          {message && (
            <p role={message.error ? 'alert' : 'status'} className={`text-sm ${message.error ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>
              {message.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}
