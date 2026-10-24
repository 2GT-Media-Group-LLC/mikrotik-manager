import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';
import { timeFormatQueryKey, useTimeFormatPreferences } from '../../hooks/useTimeFormatPreferences';
import { useIsFleetAdmin } from '../../hooks/useCanWrite';
import { authApi, settingsApi } from '../../services/api';
import { isTimeFormat, resolveTimeFormat, type TimeFormat } from '../../utils/dateTimeFormat';
import type { TimeFormatPreference } from '../../types/timeFormat';

export default function TimeFormatSetting() {
  const { formatTime } = useDateTimeFormat();
  const { preference, systemDefault, userId, isPending, isError } = useTimeFormatPreferences();
  const isAdmin = useIsFleetAdmin();
  const queryClient = useQueryClient();
  const [systemChoice, setSystemChoice] = useState<TimeFormat | null>(null);
  const browserFormat = resolveTimeFormat('browser') === '12h' ? '12-hour' : '24-hour';
  const formatName = (value: TimeFormat) => value === 'browser' ? `Browser default (${browserFormat})`
    : value === '12h' ? '12-hour (AM/PM)' : '24-hour';

  const personalMutation = useMutation({
    mutationFn: ({ preference: value }: { userId: number; preference: TimeFormatPreference }) => authApi.setTimeFormat(value),
    onSuccess: (response, variables) => queryClient.setQueryData(timeFormatQueryKey(variables.userId), response.data),
  });
  const systemMutation = useMutation({
    mutationFn: (value: TimeFormat) => settingsApi.update({ time_format_default: value }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        queryClient.invalidateQueries({ queryKey: ['time-format-preference'] }),
      ]);
      setSystemChoice(null);
    },
  });

  return (
    <div className="card p-5 space-y-4">
      <h3 className="font-semibold text-gray-900 dark:text-white">Time format</h3>
      {isAdmin && (
        <div className="space-y-2">
          <label htmlFor="system-time-format" className="text-sm font-medium text-gray-700 dark:text-slate-300">System default</label>
          <p className="text-xs text-gray-400 dark:text-slate-500">Used by accounts that follow the system default. Personal choices are preserved.</p>
          <div className="flex flex-wrap items-center gap-2">
            <select id="system-time-format" className="input text-sm w-auto" value={systemChoice ?? systemDefault}
              disabled={isPending || isError || systemMutation.isPending}
              onChange={e => { if (isTimeFormat(e.target.value)) setSystemChoice(e.target.value); }}>
              <option value="browser">Browser default</option>
              <option value="12h">12-hour (AM/PM)</option>
              <option value="24h">24-hour</option>
            </select>
            <button type="button" className="btn-primary text-sm" disabled={systemChoice === null || systemMutation.isPending}
              onClick={() => { if (systemChoice) systemMutation.mutate(systemChoice); }}>
              {systemMutation.isPending ? 'Saving…' : 'Save system default'}
            </button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <label htmlFor="time-format" className="text-sm font-medium text-gray-700 dark:text-slate-300">My time format</label>
        <p className="text-xs text-gray-400 dark:text-slate-500">Saved to your account across browsers. Changes here affect only you.</p>
        <div className="flex flex-wrap items-center gap-3">
          <select id="time-format" className="input text-sm w-auto" value={preference}
            disabled={isPending || isError || personalMutation.isPending}
            onChange={e => {
              const value = e.target.value;
              if (userId !== undefined && (value === 'system' || isTimeFormat(value))) personalMutation.mutate({ userId, preference: value });
            }}>
            <option value="system">System default ({formatName(systemDefault)})</option>
            <option value="browser">Browser default ({browserFormat})</option>
            <option value="12h">12-hour (AM/PM)</option>
            <option value="24h">24-hour</option>
          </select>
          <span className="text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap" aria-live="polite">
            {formatTime(new Date(2000, 0, 1, 14, 30))}
          </span>
        </div>
      </div>
      {(isError || personalMutation.isError || systemMutation.isError) &&
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">Could not load or save the time format. Please try again.</p>}
    </div>
  );
}
