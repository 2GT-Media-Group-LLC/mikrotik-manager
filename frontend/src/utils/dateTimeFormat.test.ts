import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDateTimeFormat, resolveTimeFormat } from './dateTimeFormat';

afterEach(() => vi.restoreAllMocks());

describe('browser default', () => {
  it.each([
    ['en-US', '12h'],
    ['en-GB', '24h'],
    ['nb-NO', '24h'],
    ['en-US-u-hc-h23', '24h'],
    ['en-GB-u-hc-h12', '12h'],
  ] as const)('uses the hour cycle for %s', (locale, expected) => {
    expect(resolveTimeFormat('browser', locale)).toBe(expected);
  });

  it('consults the runtime locale when no locale is supplied', () => {
    const original = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
      return new original(locales ?? 'nb-NO', options);
    });
    expect(resolveTimeFormat('browser')).toBe('24h');
    expect(spy).toHaveBeenCalledWith(undefined, { hour: 'numeric' });
  });
});

describe('explicit clock preferences', () => {
  it.each(['en-US', 'en-GB', 'nb-NO'])('supports 24-hour time under %s', (locale) => {
    const formatter = createDateTimeFormat('24h', locale);
    expect(formatter.formatClockTime(14, 30)).toBe('14:30');
    expect(formatter.formatClockTime(0, 0)).toBe('00:00');
    expect(formatter.formatClockTime(12, 0)).toBe('12:00');
    expect(formatter.formatClockTime(23, 59)).toBe('23:59');
  });

  it.each(['en-US', 'en-GB'])('supports AM/PM under %s', (locale) => {
    const formatter = createDateTimeFormat('12h', locale);
    expect(formatter.formatClockTime(14, 30)).toMatch(/^02:30 (PM|pm)$/);
    expect(formatter.formatClockTime(0, 0)).toMatch(/^12:00 (AM|am)$/);
    expect(formatter.formatClockTime(12, 0)).toMatch(/^12:00 (PM|pm)$/);
    expect(formatter.formatClockTime(23, 59)).toMatch(/^11:59 (PM|pm)$/);
  });

  it('formats seconds in logs and short chart labels consistently', () => {
    const date = '2026-10-10T14:30:45Z';
    const us = createDateTimeFormat('24h', 'en-US');
    expect(us.formatTime(date, { timeZone: 'UTC', second: '2-digit' })).toBe('14:30:45');
    expect(us.formatDateTime(date, { timeZone: 'UTC', year: undefined, second: '2-digit' })).toBe('Oct 10, 14:30:45');
    const gb = createDateTimeFormat('12h', 'en-GB');
    expect(gb.formatDateTime(date, { timeZone: 'UTC' })).toBe('10 Oct 2026, 02:30 pm');
  });
});

describe('timezones and source values', () => {
  it('handles an invalid timestamp without breaking the view', () => {
    const formatter = createDateTimeFormat('24h', 'en-US');
    expect(formatter.formatTime('invalid')).toBe('—');
    expect(formatter.formatDateTime(new Date(NaN))).toBe('—');
  });

  it('keeps the instant and timezone independent of the hour preference', () => {
    const date = new Date('2026-10-10T12:30:00Z');
    const original = date.toISOString();
    expect(createDateTimeFormat('24h', 'en-US').formatTime(date, { timeZone: 'Europe/Oslo' })).toBe('14:30');
    expect(createDateTimeFormat('12h', 'en-US').formatTime(date, { timeZone: 'Europe/Oslo' })).toBe('02:30 PM');
    expect(createDateTimeFormat('24h', 'en-US').formatTime(date, { timeZone: 'UTC' })).toBe('12:30');
    expect(date.toISOString()).toBe(original);
  });

  it('preserves both instants of the repeated autumn hour', () => {
    const formatter = createDateTimeFormat('24h', 'nb-NO');
    for (const value of ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
      expect(formatter.formatTime(value, { timeZone: 'Europe/Oslo' })).toBe('02:30');
    }
  });

  it('reuses Intl formatters for repeated chart options', () => {
    const formatter = createDateTimeFormat('24h', 'en-US');
    const original = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
      return new original(locales, options);
    });
    formatter.formatTime(0, { timeZone: 'UTC' });
    formatter.formatTime(60_000, { timeZone: 'UTC' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
