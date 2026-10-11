/**
 * The text for a failed change. With no answer at all (a timeout, or the
 * connection dropped), the change may well have gone through: saying "failed"
 * then was wrong, and the user retried into the device lock (#258).
 */
export function changeErrorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; code?: string; message?: string };
  if (e?.response?.data?.error) return e.response.data.error;
  if (!e?.response) {
    return 'MTM didn’t get an answer in time. The change may still be finishing on the device: '
      + 'the port list refreshes in a moment, so check it before trying again.';
  }
  return fallback;
}
