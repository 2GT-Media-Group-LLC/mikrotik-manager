import { useMemo } from 'react';
import { useTimeFormatPreferences } from './useTimeFormatPreferences';
import { createDateTimeFormat } from '../utils/dateTimeFormat';

/** Subscribe each view so changing the preference updates its timestamps. */
export function useDateTimeFormat() {
  const { effectiveTimeFormat: timeFormat } = useTimeFormatPreferences();
  const formatters = useMemo(() => createDateTimeFormat(timeFormat), [timeFormat]);
  return { ...formatters, timeFormat };
}
