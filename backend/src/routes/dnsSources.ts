import { Router } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { seal } from '../utils/sealed';
import { parseDnsSource } from '../utils/dnsSourceInput';
import { getJson, querylogUrl, pollSource, type DnsSourceRow } from '../services/dns/DnsLogService';
import { unseal } from '../utils/sealed';

/**
 * AdGuard Home sources for DNS query logs (#366 step 3). Fleet admins only:
 * the manager calls the address with the saved login. The password is stored
 * sealed and never sent back, only whether there is one.
 */
const router = Router();
router.use(requireAuth, requireAdmin);

const PUBLIC_COLUMNS = `s.id, s.name, s.site_id, st.name AS site_name, s.url, s.username, (s.password <> '') AS has_password,
  s.tls_verify, s.enabled, s.cursor_at, s.last_polled_at, s.last_error, s.queries_counted, s.created_at`;

async function siteExists(id: number): Promise<boolean> {
  return !!(await queryOne(`SELECT 1 FROM sites WHERE id = $1`, [id]));
}

router.get('/', async (_req, res) => {
  res.json(await query(`SELECT ${PUBLIC_COLUMNS} FROM dns_sources s LEFT JOIN sites st ON st.id = s.site_id ORDER BY s.name`));
});

router.post('/', async (req, res) => {
  const p = parseDnsSource(req.body ?? {});
  if ('error' in p) return res.status(400).json({ error: p.error, field: p.field });
  if (!(await siteExists(p.value.site_id))) return res.status(400).json({ error: 'That site doesn\'t exist.', field: 'site_id' });
  const v = p.value;
  const row = await queryOne<{ id: number }>(
    `INSERT INTO dns_sources (name, site_id, url, username, password, tls_verify, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [v.name, v.site_id, v.url, v.username, v.password ? seal(v.password) : '', v.tls_verify, v.enabled]);
  res.status(201).json({ id: row!.id });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const saved = await queryOne<DnsSourceRow>(`SELECT * FROM dns_sources WHERE id = $1`, [Number.isSafeInteger(id) ? id : 0]);
  if (!saved) return res.status(404).json({ error: 'Source not found' });
  const p = parseDnsSource(req.body ?? {}, saved);
  if ('error' in p) return res.status(400).json({ error: p.error, field: p.field });
  if (!(await siteExists(p.value.site_id))) return res.status(400).json({ error: 'That site doesn\'t exist.', field: 'site_id' });
  const v = p.value;
  // A different server or site starts its log afresh.
  const restart = v.url !== saved.url || v.site_id !== saved.site_id;
  await query(
    `UPDATE dns_sources SET name=$2, site_id=$3, url=$4, username=$5, password=$6, tls_verify=$7, enabled=$8,
            cursor_at = CASE WHEN $9 THEN NULL ELSE cursor_at END, last_error = CASE WHEN $9 THEN NULL ELSE last_error END
      WHERE id = $1`,
    [id, v.name, v.site_id, v.url, v.username, v.password === undefined ? saved.password : (v.password ? seal(v.password) : ''),
      v.tls_verify, v.enabled, restart]);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const rows = await query(`DELETE FROM dns_sources WHERE id = $1 RETURNING id`, [Number(req.params.id) || 0]);
  if (!rows.length) return res.status(404).json({ error: 'Source not found' });
  res.json({ ok: true });
});

// POST /api/dns-sources/test — check an address and login before saving: the
// form's values, with the saved password of `id` when it's left out (under
// the same rule as saving).
router.post('/test', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const savedId = Number(body.id);
  const saved = Number.isSafeInteger(savedId) && savedId > 0
    ? await queryOne<DnsSourceRow>(`SELECT * FROM dns_sources WHERE id = $1`, [savedId]) : null;
  const p = parseDnsSource({ name: 'test', site_id: 1, ...body }, saved ?? undefined);
  if ('error' in p) return res.status(400).json({ error: p.error, field: p.field });
  const pass = p.value.password !== undefined ? p.value.password : saved?.password ? unseal(saved.password) : '';
  try {
    const r = await getJson(querylogUrl(p.value.url).replace('limit=1000', 'limit=5'), p.value.username, pass, p.value.tls_verify) as { data?: unknown[] };
    if (!Array.isArray(r?.data)) return res.status(400).json({ error: 'That answered, but not with a query log. Is this the AdGuard Home address?' });
    res.json({ ok: true, entries: r.data.length });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /api/dns-sources/:id/poll — read new entries now, rather than within the minute.
router.post('/:id/poll', async (req, res) => {
  const src = await queryOne<DnsSourceRow>(`SELECT * FROM dns_sources WHERE id = $1`, [Number(req.params.id) || 0]);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  try {
    const r = await pollSource(src);
    res.json({ ok: true, counted: r.used });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

export default router;
