import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import * as qrcode from 'qrcode';
import { query, queryOne } from '../config/database';
import { signToken, signRawToken, verifyRawToken, requireAuth } from '../middleware/auth';
import { getSecretsInfo } from '../utils/secrets';
import { loginRateLimit, rateLimitRedis } from '../middleware/rateLimitRedis';
import { validatePassword } from '../utils/passwordPolicy';

const router = Router();

router.get(
  '/security-status',
  requireAuth,
  rateLimitRedis({ windowSec: 60, max: 10, keyPrefix: 'security-status', allMethods: true }),
  async (_req: Request, res: Response) => {
    const warnings: string[] = [];

    // Secrets self-heal to strong auto-generated values, so the only remaining
    // risk is an auto-generated secret that couldn't be persisted (it would
    // churn on restart) — surface that rather than "default".
    const secrets = getSecretsInfo();
    if (secrets.ephemeral) {
      warnings.push('secrets_not_persisted');
    }

    const adminUser = await queryOne<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE username = 'admin' LIMIT 1`
    );
    if (adminUser && (await bcrypt.compare('admin', adminUser.password_hash))) {
      warnings.push('admin_password_default');
    }

    return res.json({ warnings });
  }
);

// lgtm[js/missing-rate-limiting] - loginRateLimit() middleware handles per-IP rate limiting
router.post('/login', loginRateLimit(), async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = await queryOne<{
    id: number;
    username: string;
    password_hash: string;
    role: string;
    totp_enabled: boolean;
  }>(`SELECT id, username, password_hash, role, totp_enabled FROM users WHERE username = $1`, [username]);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (user.totp_enabled) {
    const totpToken = signRawToken({ userId: user.id, partial: true }, { expiresIn: '5m' });
    return res.json({ requires_totp: true, totp_token: totpToken });
  }

  const token = signToken({ userId: user.id, username: user.username, role: user.role });
  return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// Exchange partial TOTP token + code for a full session token
router.post('/totp/verify', rateLimitRedis({ windowSec: 60, max: 5, keyPrefix: 'totp-verify', allMethods: true }), async (req: Request, res: Response) => {
  const { totp_token, code } = req.body as { totp_token?: string; code?: string };
  if (!totp_token || !code) {
    return res.status(400).json({ error: 'totp_token and code are required' });
  }
  let payload: { userId: number; partial: boolean };
  try {
    payload = verifyRawToken<{ userId: number; partial: boolean }>(totp_token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired TOTP token' });
  }
  if (!payload.partial) {
    return res.status(401).json({ error: 'Invalid token type' });
  }

  const user = await queryOne<{ id: number; username: string; role: string; totp_secret: string | null; totp_enabled: boolean }>(
    `SELECT id, username, role, totp_secret, totp_enabled FROM users WHERE id = $1`,
    [payload.userId]
  );
  if (!user || !user.totp_enabled || !user.totp_secret) {
    return res.status(401).json({ error: 'TOTP not configured' });
  }

  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totp_secret), digits: 6, period: 30 });
  const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
  if (delta === null) {
    return res.status(401).json({ error: 'Invalid TOTP code' });
  }

  const token = signToken({ userId: user.id, username: user.username, role: user.role });
  return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// Generate a new TOTP secret + QR code for the current user (does not enable yet).
// Requires the current password so a hijacked session can't enroll 2FA and lock
// the legitimate user out.
router.post('/totp/setup', requireAuth, async (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'Current password is required to set up 2FA' });

  const account = await queryOne<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  if (!account?.password_hash) {
    return res.status(400).json({ error: 'This account has no local password (SSO). Set a password before enabling 2FA.' });
  }
  if (!(await bcrypt.compare(password, account.password_hash))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: 'MikroTik Manager',
    label: req.user!.username,
    secret,
    digits: 6,
    period: 30,
  });
  const uri = totp.toString();
  const qrDataUrl = await qrcode.toDataURL(uri);
  // Store the pending secret temporarily on the user row (not yet enabled)
  await query(`UPDATE users SET totp_secret = $1 WHERE id = $2`, [secret.base32, req.user!.userId]);
  return res.json({ secret: secret.base32, uri, qr: qrDataUrl });
});

// Confirm the TOTP setup by validating a code — enables TOTP
router.post('/totp/confirm', requireAuth, async (req: Request, res: Response) => {
  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: 'code is required' });

  const user = await queryOne<{ totp_secret: string | null }>(
    `SELECT totp_secret FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  if (!user?.totp_secret) return res.status(400).json({ error: 'Run /totp/setup first' });

  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totp_secret), digits: 6, period: 30 });
  const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
  if (delta === null) return res.status(401).json({ error: 'Invalid code' });

  await query(`UPDATE users SET totp_enabled = true WHERE id = $1`, [req.user!.userId]);
  return res.json({ ok: true });
});

// Disable TOTP — requires password confirmation
router.post('/totp/disable', requireAuth, async (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'password is required' });

  const user = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  await query(`UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1`, [req.user!.userId]);
  return res.json({ ok: true });
});

// Return current TOTP status for the authenticated user
router.get('/totp/status', requireAuth, async (req: Request, res: Response) => {
  const user = await queryOne<{ totp_enabled: boolean }>(
    `SELECT totp_enabled FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  return res.json({ totp_enabled: user?.totp_enabled ?? false });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

router.post('/logout', requireAuth, (_req: Request, res: Response) => {
  // JWT is stateless; client just discards token
  res.json({ message: 'Logged out' });
});

router.put('/password', requireAuth, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  const pwError = validatePassword(newPassword);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  const user = await queryOne<{ id: number; password_hash: string }>(
    `SELECT id, password_hash FROM users WHERE id = $1`,
    [req.user!.userId]
  );

  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.user!.userId]);
  return res.json({ message: 'Password updated' });
});

export default router;
