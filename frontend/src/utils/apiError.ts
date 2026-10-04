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
