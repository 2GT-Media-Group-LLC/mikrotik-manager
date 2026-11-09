/**
 * The message to show for a failed API call: the server's own explanation
 * (`{ error }` in the body) when there is one, not axios's "Request failed
 * with status code 500" (#180, where that was all the reporter could see).
 */
export function apiErrorMessage(err: unknown, fallback = 'Request failed'): string {
  const body = (err as { response?: { data?: { error?: unknown; reason?: unknown } } })?.response?.data;
  if (body && typeof body.error === 'string' && body.error) return body.error;
  // Change Guard refusals explain themselves in `reason` (#205).
  if (body && typeof body.reason === 'string' && body.reason) return body.reason;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * For the long device operations (API-SSL, WebFig over HTTPS) that can run
 * for minutes while a router signs a certificate. When the manager's own
 * reason didn't arrive, say what did happen instead of a bare "Could not ..."
 * (#417): no reply in time, a proxy's error page, or no connection at all.
 * The operation may still be finishing on the manager in the first two cases.
 */
export function longRequestError(err: unknown, what: string): string {
  const e = err as { code?: string; message?: string; response?: { status?: number; statusText?: string; data?: unknown } };
  const body = e?.response?.data as { error?: unknown } | undefined;
  if (body && typeof body === 'object' && typeof body.error === 'string' && body.error) return body.error;
  const stillRunning = 'It may still finish on the manager; check the device again in a minute.';
  if (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '')) {
    return `${what}: no answer from the manager in time. ${stillRunning}`;
  }
  const status = e?.response?.status;
  if (status === 502 || status === 503 || status === 504) {
    return `${what}: the manager's reply was lost (HTTP ${status}${e.response?.statusText ? ` ${e.response.statusText}` : ''}). `
      + `A reverse proxy in front of MikroTik Manager that gives up on long requests does this, as does a backend restart. ${stillRunning}`;
  }
  if (status) return `${what} (HTTP ${status}${e.response?.statusText ? ` ${e.response.statusText}` : ''})`;
  if (e?.message) return `${what}: ${e.message}`;
  return what;
}
