import { AlertTriangle } from 'lucide-react';

/**
 * What a view shows when its data couldn't be read (outside review U5). An
 * empty or "all clear" state in that case tells an operator everything is
 * fine when the truth is "unknown".
 */
export default function LoadError({ what, error, className = '' }: { what: string; error?: unknown; className?: string }) {
  const detail = (error as { response?: { data?: { error?: string } } })?.response?.data?.error
    ?? (error as Error | undefined)?.message;
  return (
    <div className={`flex items-start gap-2 p-4 text-sm text-amber-700 dark:text-amber-400 ${className}`}>
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>
        Couldn&apos;t load {what}, so this isn&apos;t showing the real state.
        {detail ? <span className="text-amber-600/80 dark:text-amber-500/80"> ({detail})</span> : null}
      </span>
    </div>
  );
}
