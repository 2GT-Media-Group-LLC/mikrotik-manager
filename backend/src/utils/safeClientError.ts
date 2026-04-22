/**
 * Return a short, stable message for API clients; log full detail server-side only.
 */
export function safeConnectionError(context: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  console.warn(`[${context}]`, raw);
  return 'Cannot connect to device. Check IP, port, credentials, and that the API service is reachable.';
}
