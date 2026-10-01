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
 * username, over the API transport, **from the manager's own address** are
 * dropped — which is exactly the set this manager creates.
 *
 * The address matters (outside review S9): matching the username alone also
 * discarded the logins of anyone else using that account, another operator or
 * an attacker with the manager's credentials, as if they were the manager.
 * The manager's address, as the device sees it, is learned from the device's
 * own list of active sessions (see learnManagerAddresses).
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
const ACCOUNT_LINE = /^user\s+(\S+)\s+logged\s+(?:in|out)\s+from\s+(\S+)\s+via\s+api\b/i;

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
export function isOwnApiSession(
  line: LogLineLike,
  apiUsername: string | null | undefined,
  managerAddresses?: ReadonlySet<string>,
): boolean {
  const user = (apiUsername || '').trim();
  if (!user) return false;

  const topics = (line.topics || '').toLowerCase();
  if (!topics.includes('account')) return false;

  const m = ACCOUNT_LINE.exec((line.message || '').trim());
  if (!m) return false;

  // Case-sensitive: RouterOS usernames are, and "Admin" is a different account
  // from "admin" as far as the device is concerned.
  if (m[1] !== user) return false;
  // From the manager's own address only. An empty set (not learned yet, or
  // ambiguous) keeps the line: noise is better than hiding someone.
  if (managerAddresses) return managerAddresses.has(m[2]);
  return true;
}

/**
 * The manager's address as this device sees it, from /user/active rows: the
 * address of the API sessions of the manager's account, but only when they all
 * come from one address. The manager's own poll is one of them; if another
 * host is using the same account at that moment there's no telling which is
 * the manager, and nothing is learned.
 */
export function managerAddressFromActive(rows: Record<string, string>[], apiUsername: string | null | undefined): string | null {
  const user = (apiUsername || '').trim();
  if (!user) return null;
  const addrs = new Set(
    rows
      .filter((r) => r['name'] === user && (r['via'] || '').toLowerCase().startsWith('api'))
      .map((r) => (r['address'] || '').trim())
      .filter(Boolean),
  );
  return addrs.size === 1 ? [...addrs][0] : null;
}

/**
 * Drop our own session noise, keeping everything else in order.
 *
 * Returns the kept lines and how many were dropped, because a silent filter
 * that removes 99.8% of collected rows should be able to say so in the log.
 */
export function stripOwnSessionNoise<T extends LogLineLike>(
  lines: T[],
  apiUsername: string | null | undefined,
  managerAddresses?: ReadonlySet<string>,
): { kept: T[]; dropped: number } {
  const kept = lines.filter((l) => !isOwnApiSession(l, apiUsername, managerAddresses));
  return { kept, dropped: lines.length - kept.length };
}
