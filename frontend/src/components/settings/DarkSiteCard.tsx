import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Moon, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { systemApi, settingsApi } from '../../services/api';

/**
 * Dark Site Mode: every feature that reaches the internet, in one place.
 *
 * These used to be found one at a time by a user on an isolated network: maps
 * first, then the dashboard map that ignored the maps switch, then the update
 * check calling GitHub. Listing each with where it goes and what stops working
 * lets an operator match the screen against a firewall log and decide feature
 * by feature, rather than trusting a single switch they cannot inspect.
 *
 * All on by default. The list comes from the server, which also enforces it.
 */

interface Props {
  isAdmin: boolean;
}

export default function DarkSiteCard({ isAdmin }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['dark-site'],
    queryFn: () => systemApi.darkSite().then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, boolean>) => settingsApi.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dark-site'] });
      // Other screens read these through the general settings query.
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      qc.invalidateQueries({ queryKey: ['version-check'] });
    },
  });

  const features = data?.features ?? [];
  const offCount = features.filter((f) => !f.enabled).length;
  const setAll = (on: boolean) =>
    save.mutate(Object.fromEntries(features.map((f) => [f.key, on])));

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Moon className="w-4 h-4 text-blue-500" />
        <h3 className="font-semibold text-gray-900 dark:text-white">Dark Site Mode</h3>
        {offCount > 0 && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">
            {offCount} of {features.length} off
          </span>
        )}
      </div>
      <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
        Every feature that makes a request to the internet on its own. Turn off what an isolated
        or restricted network should not reach; everything else keeps working. Alert channels
        such as Slack, Telegram, ntfy and webhooks are not listed here because they only send
        when you configure a destination.
      </p>

      {isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-4">
          {features.map((f) => (
            <div key={f.key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-700 dark:text-slate-300">{f.label}</div>
                <div className="text-[11px] font-mono text-gray-400 dark:text-slate-500 break-words">{f.destination}</div>
                {!f.enabled && (
                  <div className="text-[11.5px] text-amber-600 dark:text-amber-400 mt-0.5">{f.cost}</div>
                )}
              </div>
              <button
                onClick={() => isAdmin && save.mutate({ [f.key]: !f.enabled })}
                disabled={!isAdmin || save.isPending}
                aria-label={`${f.enabled ? 'Disable' : 'Enable'} ${f.label}`}
                className={clsx(
                  'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                  isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                  f.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                )}
              >
                <span className={clsx(
                  'inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200',
                  f.enabled ? 'translate-x-5' : 'translate-x-0'
                )} />
              </button>
            </div>
          ))}
        </div>
      )}

      {isAdmin && features.length > 0 && (
        <div className="flex items-center justify-end gap-2 mt-5 pt-4 border-t border-gray-100 dark:border-slate-700">
          {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
          <button
            onClick={() => setAll(true)}
            disabled={save.isPending || offCount === 0}
            className="btn-secondary text-[12px] disabled:opacity-50"
          >
            Enable all
          </button>
          <button
            onClick={() => setAll(false)}
            disabled={save.isPending || offCount === features.length}
            className="btn-secondary text-[12px] disabled:opacity-50"
          >
            Disable all
          </button>
        </div>
      )}
    </div>
  );
}
