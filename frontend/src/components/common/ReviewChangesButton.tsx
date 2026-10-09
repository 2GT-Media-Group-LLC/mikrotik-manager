import { useState } from 'react';
import { Eye, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { previewAll, type ChangePreview } from '../../services/api';
import ChangePreviewModal from './ChangePreviewModal';

/**
 * "Review changes" (#255): an optional look at what a form would send to the
 * device before applying it. The form works exactly as before without it.
 *
 * `request` must call the same API method the form's Save does, with the same
 * arguments; it is sent as a preview, so nothing is applied. A form that saves
 * in several requests passes `requests` instead: one call per request, in order.
 */
export default function ReviewChangesButton({ request, requests, onApply, applyLabel, deviceName, disabled, className }: {
  request?: () => Promise<unknown>;
  requests?: () => (() => Promise<unknown>)[];
  /** Apply from the review, as the form's own Save would. */
  onApply?: () => void;
  applyLabel?: string;
  deviceName?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewAll(requests ? requests() : request ? [request] : []));
    } catch (e) {
      const d = (e as { response?: { data?: { error?: string } } })?.response?.data;
      setError(d?.error || (e as Error).message || 'Couldn’t build the preview');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={clsx('btn-secondary text-sm inline-flex items-center gap-1.5', className)}
        disabled={disabled || busy} onClick={() => { void run(); }}
        title="See exactly what would be sent to the device, without applying it">
        {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
        Review changes
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      {preview && (
        <ChangePreviewModal preview={preview} deviceName={deviceName} onApply={onApply} applyLabel={applyLabel}
          onClose={() => setPreview(null)} />
      )}
    </>
  );
}
