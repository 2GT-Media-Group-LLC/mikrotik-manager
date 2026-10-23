/** Free text is untrusted evidence. Field allowlists are applied before this last defence. */
export function safeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(password|passwd|passphrase|secret|token|community|private[-_]key|preshared[-_]key|wpa2?-pre-shared-key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    // eslint-disable-next-line no-control-regex -- Strip control bytes from external device text.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, 2000);
}

export function selectFields(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((key) => {
    const value = row[key];
    return [key, typeof value === 'string' ? safeText(value)
      : value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value
      : value instanceof Date ? value.toISOString() : null];
  }));
}

export function observation(time: unknown, failed = false, maxAgeMs = 900_000) {
  const date = time instanceof Date ? time : typeof time === 'string' ? new Date(time) : null;
  const valid = date !== null && Number.isFinite(date.getTime());
  return {
    collected_at: valid ? date.toISOString() : null,
    status: !valid ? 'unavailable' : failed ? 'partial' : Date.now() - date.getTime() > maxAgeMs ? 'stale' : 'available',
  };
}
