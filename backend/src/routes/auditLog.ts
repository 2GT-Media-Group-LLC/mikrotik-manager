import { Router } from 'express';
import { query } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/audit-log?page=1&limit=50&userId=&entityType=&search=&from=&to=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (req.query.userId) {
    params.push(parseInt(String(req.query.userId), 10));
    conditions.push(`user_id = $${params.length}`);
  }
  if (req.query.entityType) {
    params.push(String(req.query.entityType));
    conditions.push(`entity_type = $${params.length}`);
  }
  if (req.query.search) {
    params.push(`%${String(req.query.search)}%`);
    conditions.push(`(summary ILIKE $${params.length} OR username ILIKE $${params.length} OR ip_address ILIKE $${params.length})`);
  }
  if (req.query.from) {
    params.push(String(req.query.from));
    conditions.push(`created_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(String(req.query.to));
    conditions.push(`created_at <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRows] = await Promise.all([
    query<{
      id: number; user_id: number | null; username: string | null;
      method: string; path: string; entity_type: string | null;
      entity_id: number | null; summary: string; ip_address: string | null;
      status_code: number | null; created_at: string;
    }>(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query<{ count: string }>(`SELECT COUNT(*) as count FROM audit_log ${where}`, params),
  ]);

  res.json({
    rows,
    total: parseInt(countRows[0]?.count || '0', 10),
    page,
    limit,
  });
});

export default router;
