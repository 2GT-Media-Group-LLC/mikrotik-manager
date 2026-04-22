import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../config/database';
import { signToken, requireAuth } from '../middleware/auth';
import { loginRateLimit } from '../middleware/rateLimitRedis';

const router = Router();

const DEFAULT_JWT_SECRET = 'changeme';
const DEFAULT_ENCRYPTION_KEY = 'defaultkey32byteslongencryptkey!';

router.get('/security-status', requireAuth, async (_req: Request, res: Response) => {
  const warnings: string[] = [];

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET) {
    warnings.push('jwt_secret_default');
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY === DEFAULT_ENCRYPTION_KEY) {
    warnings.push('encryption_key_default');
  }

  const adminUser = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE username = 'admin' LIMIT 1`
  );
  if (adminUser && (await bcrypt.compare('admin', adminUser.password_hash))) {
    warnings.push('admin_password_default');
  }

  return res.json({ warnings });
});

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
  }>(`SELECT id, username, password_hash, role FROM users WHERE username = $1`, [username]);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ userId: user.id, username: user.username, role: user.role });
  return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
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
