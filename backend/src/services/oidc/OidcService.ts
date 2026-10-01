/**
 * OIDC Authorization-Code (PKCE) flow orchestration.
 *
 * beginLogin() builds the authorize URL and stashes the per-request PKCE/nonce
 * transaction in Redis (short TTL, single-use). completeLogin() validates the
 * callback (openid-client checks the ID-token signature via JWKS plus iss/aud/
 * exp/nonce and the PKCE verifier), then resolves the identity to a local user.
 */
import { Issuer, generators } from 'openid-client';
import type { Client, TokenSet } from 'openid-client';
import { createHash } from 'crypto';
import { redis } from '../../config/redis';
import { query, queryOne } from '../../config/database';
import { loadOidcConfig, getClientSecret, type OidcConfig, type AppRole } from './oidcConfig';
import { endAllSessions } from '../../utils/sessionState';
import {
  extractGroups, mapGroupsToRole, deriveUsername, getEmail, isEmailVerified, emailDomainAllowed,
} from './claimMapping';

const TX_TTL_SECONDS = 600; // 10 minutes
const txKey = (state: string): string => `oidc:tx:${state}`;

export interface ResolvedUser {
  id: number;
  username: string;
  role: AppRole;
}

interface Transaction {
  nonce: string;
  code_verifier: string;
  redirectUri: string;
  returnTo: string;
  /** SHA-256 of the browser-binding value held in the starting browser's cookie (S2). */
  bindHash?: string;
}

/** Hash of a browser-binding value, as stored server-side. */
export function bindingHash(binding: string): string {
  return createHash('sha256').update(binding).digest('hex');
}

// Cache the discovered client; rebuild when the relevant config or redirect URI changes.
let clientCache: { key: string; client: Client } | null = null;

function configFingerprint(config: OidcConfig, redirectUri: string): string {
  return createHash('sha256')
    .update([config.issuer_url, config.client_id, config.client_secret_encrypted ?? '', redirectUri].join('|'))
    .digest('hex');
}

async function getClient(config: OidcConfig, redirectUri: string): Promise<Client> {
  if (!config.issuer_url || !config.client_id) throw new Error('OIDC is not fully configured');
  const key = configFingerprint(config, redirectUri);
  if (clientCache && clientCache.key === key) return clientCache.client;

  const issuer = await Issuer.discover(config.issuer_url);
  const secret = getClientSecret(config);
  const client = new issuer.Client({
    client_id: config.client_id,
    client_secret: secret ?? undefined,
    redirect_uris: [redirectUri],
    response_types: ['code'],
    // Public client (no secret) must use PKCE-only token auth.
    token_endpoint_auth_method: secret ? 'client_secret_basic' : 'none',
  });
  clientCache = { key, client };
  return client;
}

/** Invalidate the cached client after a config change. */
export function resetOidcClientCache(): void {
  clientCache = null;
}

/**
 * Start a login. `binding` is a random value the route also puts in an
 * HttpOnly cookie on this browser; only its hash is stored, and the callback
 * must come from a browser holding the value (outside review S2). Without it,
 * someone could send a victim the callback link of a login they started and
 * sign the victim in to the attacker's account.
 */
export async function beginLogin(redirectUri: string, returnTo: string, binding: string): Promise<string> {
  const config = await loadOidcConfig();
  if (!config.enabled) throw new Error('OIDC login is not enabled');
  const client = await getClient(config, redirectUri);

  const state = generators.state();
  const nonce = generators.nonce();
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);

  const tx: Transaction = { nonce, code_verifier, redirectUri, returnTo, bindHash: bindingHash(binding) };
  await redis.set(txKey(state), JSON.stringify(tx), 'EX', TX_TTL_SECONDS);

  return client.authorizationUrl({
    scope: config.scopes || 'openid profile email',
    state,
    nonce,
    code_challenge,
    code_challenge_method: 'S256',
  });
}

export async function completeLogin(
  params: Record<string, string>, binding: string | null,
): Promise<{ user: ResolvedUser; returnTo: string; bindHash: string }> {
  const state = params.state;
  if (!state) throw new Error('Missing state');

  const raw = await redis.get(txKey(state));
  if (!raw) throw new Error('Login session expired or invalid — please try again');
  await redis.del(txKey(state)); // single use
  const tx: Transaction = JSON.parse(raw);

  // Only the browser that started this login may finish it (S2).
  if (!tx.bindHash || !binding || bindingHash(binding) !== tx.bindHash) {
    throw new Error('This sign-in was started in a different browser or has expired. Start it again from the login page.');
  }

  // An admin may have turned SSO off since the login began (S2).
  const config = await loadOidcConfig();
  if (!config.enabled) throw new Error('SSO sign-in has been turned off');
  const client = await getClient(config, tx.redirectUri);

  const tokenSet: TokenSet = await client.callback(tx.redirectUri, params, {
    code_verifier: tx.code_verifier,
    state,
    nonce: tx.nonce,
  });

  let claims: Record<string, unknown> = { ...tokenSet.claims() };
  // Some IdPs put groups only in the userinfo response, not the ID token.
  if (!claims[config.groups_claim] && tokenSet.access_token) {
    try {
      const userinfo = await client.userinfo(tokenSet);
      claims = { ...claims, ...userinfo };
    } catch { /* userinfo optional */ }
  }

  const user = await resolveUser(claims, config);
  return { user, returnTo: tx.returnTo, bindHash: tx.bindHash };
}

async function resolveUser(claims: Record<string, unknown>, config: OidcConfig): Promise<ResolvedUser> {
  const sub = String(claims.sub ?? '');
  const issuer = String(claims.iss ?? '');
  if (!sub || !issuer) throw new Error('ID token missing sub/iss');

  const email = getEmail(claims, config);
  const mappedRole = mapGroupsToRole(extractGroups(claims, config.groups_claim), config.group_role_map);
  // With group mappings configured, the identity provider decides the role at
  // every sign-in: a user whose mapped group was removed falls back to the
  // default role instead of keeping it (outside review S3). Without mappings,
  // roles are managed here and left alone.
  const groupsDecide = Object.keys(config.group_role_map || {}).length > 0;
  const roleFor = async (current: AppRole, userId: number | null): Promise<AppRole> => {
    if (!groupsDecide) return mappedRole ?? current;
    const next = mappedRole ?? config.default_role;
    if (current === 'admin' && next !== 'admin' && userId !== null && await isLastAdmin(userId)) {
      console.warn(`[OIDC] kept admin for user ${userId}: no other admin account would remain`);
      return current;
    }
    return next;
  };

  // The domain allow-list only admits an address the identity provider has
  // verified (S3). An unverified one is whatever the user typed in.
  const linked = await queryOne<{ id: number; username: string; role: AppRole }>(
    `SELECT id, username, role FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`,
    [issuer, sub]
  );
  if (config.allowed_email_domains?.length && !linked) {
    if (!email || !isEmailVerified(claims)) {
      throw new Error('Your identity provider did not confirm your email address is verified, so its domain cannot be checked');
    }
  }
  if (!emailDomainAllowed(email, config.allowed_email_domains)) {
    throw new Error('Your email domain is not permitted to sign in');
  }

  // 1. Already-linked user → authenticate and sync the role (see roleFor).
  if (linked) {
    const role = await roleFor(linked.role, linked.id);
    if (role !== linked.role) {
      await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, linked.id]);
      // A role change from the identity provider ends older sessions, as it
      // does when an admin changes it here (P2-1).
      await endAllSessions(linked.id);
    }
    if (email) await query(`UPDATE users SET email = $1 WHERE id = $2`, [email, linked.id]).catch(() => {});
    return { id: linked.id, username: linked.username, role };
  }

  // 2. Link to an existing local account by verified email
  if (config.link_by_verified_email && email && isEmailVerified(claims)) {
    const byEmail = await queryOne<{ id: number; username: string; role: AppRole }>(
      `SELECT id, username, role FROM users WHERE lower(email) = lower($1) AND oidc_subject IS NULL`,
      [email]
    );
    if (byEmail) {
      const role = await roleFor(byEmail.role, byEmail.id);
      await query(
        `UPDATE users SET oidc_issuer = $1, oidc_subject = $2, auth_provider = 'oidc', role = $3 WHERE id = $4`,
        [issuer, sub, role, byEmail.id]
      );
      return { id: byEmail.id, username: byEmail.username, role };
    }
  }

  // 3. Auto-provision a new SSO user
  if (config.auto_provision) {
    const role = mappedRole ?? config.default_role;
    const username = await uniqueUsername(deriveUsername(claims, config));
    const created = await queryOne<{ id: number; username: string; role: AppRole }>(
      `INSERT INTO users (username, email, role, auth_provider, oidc_issuer, oidc_subject)
       VALUES ($1, $2, $3, 'oidc', $4, $5)
       RETURNING id, username, role`,
      [username, email, role, issuer, sub]
    );
    if (!created) throw new Error('Failed to provision user');
    return created;
  }

  // 4. No account and provisioning disabled
  throw new Error('No account exists for this identity, and automatic provisioning is disabled');
}

/** True if `userId` is the only admin account. */
async function isLastAdmin(userId: number): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM users WHERE role = 'admin' AND id <> $1
       AND NOT EXISTS (SELECT 1 FROM user_site_roles r WHERE r.user_id = users.id)`, [userId]);
  return Number(row?.n ?? 0) === 0;
}

async function uniqueUsername(base: string): Promise<string> {
  const root = (base || 'user').slice(0, 50);
  const existing = await queryOne(`SELECT 1 FROM users WHERE username = $1`, [root]);
  if (!existing) return root;
  for (let i = 2; i <= 50; i++) {
    const suffix = `-${i}`;
    const candidate = root.slice(0, 50 - suffix.length) + suffix;
    const clash = await queryOne(`SELECT 1 FROM users WHERE username = $1`, [candidate]);
    if (!clash) return candidate;
  }
  return `${root.slice(0, 40)}-${Date.now().toString().slice(-6)}`;
}
