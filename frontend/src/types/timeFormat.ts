import type { TimeFormat } from '../utils/dateTimeFormat';

export type TimeFormatPreference = 'system' | TimeFormat;

export interface TimeFormatPreferences {
  preference: TimeFormatPreference;
  system_default: TimeFormat;
}
