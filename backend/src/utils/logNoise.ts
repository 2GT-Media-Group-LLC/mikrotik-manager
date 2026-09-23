/**
 * Discarding the log lines this manager causes by polling.
 *
 * Measured on a five-device fleet: the `events` table held 568,809 rows over
 * 36 days and was 95% of the entire database. **99.8% of those rows were this
 * manager's own API logins:**
 *
 *     system,info,account   567,814 rows   (99.8%)
 *
 *     "user admin logged in from 172.24.1.7 via api"    140,068
 *     "user admin logged out from 172.24.1.7 via api"   140,046
 *
 * A poll opens an API session, RouterOS logs the login and the logout, and the
 * next logs poll collects those two lines back and stores them. It is a closed
 * loop: the manager watching itself connect, once per poll, per device, for
 * ever. At 1,500 devices that is roughly 4.7 million rows and 3.8 GB a day, all
 * of it self-inflicted.
 *
 * What is *not* discarded matters as much. A human logging in over Winbox, SSH
 * or the web is a security-relevant event and is kept. So is an API login by
 * any other account. Only sessions matching this device's own configured API
 * username, over the API transport, are dropped — which is exactly the set this
 * manager creates.
 */

/**
 * RouterOS account lines look like:
 *
 *     user admin logged in from 172.24.1.7 via api
 *     user admin logged out from 192.168.0.76 via api
 *
 * The transport suffix is the discriminator. `via winbox`, `via ssh`,
 * `via telnet` and `via web` are all kept.
 */
const ACCOUNT_LINE = /^user\s+(\S+)\s+logged\s+(?:in|out)\b.*\bvia\s+api\b/i;

export interface LogLineLike {
  topics?: string;
  message?: string;
}

/**
 * Is this line a record of our own polling session?
 *
 * Requires both the account topic and a username match, so a differently-named
 * automation account on the same device still gets recorded.
 */
export function isOwnApiSession(line: LogLineLike, apiUsername: string | null | undefined): boolean {
  const user = (apiUsername || '').trim();
  if (!user) return false;

  const topics = (line.topics || '').toLowerCase();
  if (!topics.includes('account')) return false;

  const m = ACCOUNT_LINE.exec((line.message || '').trim());
  if (!m) return false;

  // Case-sensitive: RouterOS usernames are, and "Admin" is a different account
  // from "admin" as far as the device is concerned.
  return m[1] === user;
}

/**
 * Drop our own session noise, keeping everything else in order.
 *
 * Returns the kept lines and how many were dropped, because a silent filter
 * that removes 99.8% of collected rows should be able to say so in the log.
 */
export function stripOwnSessionNoise<T extends LogLineLike>(
  lines: T[],
  apiUsername: string | null | undefined
): { kept: T[]; dropped: number } {
  const kept = lines.filter((l) => !isOwnApiSession(l, apiUsername));
  return { kept, dropped: lines.length - kept.length };
}
