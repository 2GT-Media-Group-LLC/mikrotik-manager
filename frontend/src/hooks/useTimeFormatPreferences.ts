import { useQuery } from '@tanstack/react-query';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';

export const timeFormatQueryKey = (userId: number | undefined) => ['time-format-preference', userId] as const;

export function useTimeFormatPreferences() {
  const userId = useAuthStore((s) => s.user?.id);
  const query = useQuery({
    queryKey: timeFormatQueryKey(userId),
    queryFn: () => authApi.timeFormat().then(r => r.data),
    enabled: userId !== undefined,
    staleTime: 60_000,
  });
  const preference = query.data?.preference ?? 'system';
  const systemDefault = query.data?.system_default ?? 'browser';
  return { ...query, userId, preference, systemDefault,
    effectiveTimeFormat: preference === 'system' ? systemDefault : preference };
}
