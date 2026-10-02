import { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useActionErrorStore } from '../../store/actionErrorStore';

/** Shows a failed action that had nowhere else to report it (U5). */
export default function ActionErrorNotice() {
  const { message, dismiss } = useActionErrorStore();
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(dismiss, 12_000);
    return () => window.clearTimeout(t);
  }, [message, dismiss]);
  if (!message) return null;
  return (
    <div role="alert" className="fixed bottom-4 right-4 z-[70] max-w-md rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 shadow-lg p-3 flex items-start gap-2 text-sm text-red-800 dark:text-red-200">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span className="flex-1">That action failed: {message}</span>
      <button onClick={dismiss} className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900" aria-label="Dismiss"><X className="w-4 h-4" /></button>
    </div>
  );
}
