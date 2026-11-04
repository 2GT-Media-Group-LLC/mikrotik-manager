import { createHash, randomBytes } from 'crypto';
import { query } from '../../config/database';
import type { AuthPayload } from '../../middleware/auth';

/**
 * AI connection tokens: api_tokens rows with scope 'review'. They reach the
 * read-only review tools and nothing else (the rest of the API refuses them),
 * optionally limited to some sites. Only the hash is stored.
 */
export const REVIEW_SCOPE = 'review';

export function newReviewToken(): { token: string; hash: string; prefix: string } {
  const token = `mtm_${randomBytes(24).toString('hex')}`;
  return { token, hash: createHash('sha256').update(token).digest('hex'), prefix: token.slice(0, 12) };
}

/** The caller a review token stands for, or null when it isn't a current one. */
export async function reviewTokenUser(token: string): Promise<AuthPayload | null> {
  if (!/^mtm_[0-9a-f]{48}$/.test(token)) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  const rows = await query<{ id: number; name: string; expires_at: string | null; site_ids: number[] | null }>(
    `SELECT id, name, expires_at, site_ids FROM api_tokens WHERE token_hash = $1 AND scope = $2`, [hash, REVIEW_SCOPE]);
  const t = rows[0];
  if (!t || (t.expires_at && new Date(t.expires_at).getTime() <= Date.now())) return null;
  void query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [t.id]).catch(() => {});
  return {
    userId: -t.id,
    username: `token:${t.name}`.slice(0, 150),
    role: 'viewer',
    tokenAuth: true,
    // Site-limited like a site-scoped account; a list whose sites were all
    // deleted is empty, which sees nothing rather than the whole fleet.
    ...(t.site_ids ? { siteRoles: Object.fromEntries(t.site_ids.map((id) => [id, 'viewer'])) } : {}),
  };
}
