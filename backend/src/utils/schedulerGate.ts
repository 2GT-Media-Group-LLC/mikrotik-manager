/**
 * Expiry for a scheduler gate key (the Redis key that records when a periodic
 * task last ran): its interval plus ten minutes of slack.
 *
 * A missing key reads as "never ran", so a key that expires before its
 * interval makes the task run on every scheduler tick. That happened with a
 * fixed 10-minute expiry: daily and hourly tasks ran about every 10 minutes.
 */
export function gateTtlSeconds(intervalMs: number): number {
  const sec = Math.ceil((Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0) / 1000);
  return sec + 600;
}
