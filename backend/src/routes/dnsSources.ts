import { Router } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, settingsReadAdminWrite } from '../middleware/auth';
import { seal } from '../utils/sealed';
import { parseDnsSource } from '../utils/dnsSourceInput';
import { pollSource, testSource, dropPiholeSession, type DnsSourceRow } from '../services/dns/DnsLogService';

/**
 * AdGuard Home and Pi-hole sources for DNS query logs (#366 step 3), any
 * number per site (active/active resolvers each count their share). Fleet admins only:
 * the manager calls the address with the saved login. The password is stored
 * sealed and never sent back, only whether there is one.
 */
const router = Router();
router.use(requireAuth, settingsReadAdminWrite);

const PUBLIC_COLUMNS = `s.id, s.name, s.kind, s.site_id, st.name AS site_name, s.url, s.username, (s.password <> '') AS has_password,
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
    `INSERT INTO dns_sources (name, site_id, url, username, password, tls_verify, enabled, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [v.name, v.site_id, v.url, v.username, v.password ? seal(v.password) : '', v.tls_verify, v.enabled, v.kind]);
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
  // A different server, kind or site starts its log afresh.
  const restart = v.url !== saved.url || v.site_id !== saved.site_id || v.kind !== saved.kind;
  await dropPiholeSession(saved);
  await query(
    `UPDATE dns_sources SET name=$2, site_id=$3, url=$4, username=$5, password=$6, tls_verify=$7, enabled=$8, kind=$10,
            cursor_at = CASE WHEN $9 THEN NULL ELSE cursor_at END, last_error = CASE WHEN $9 THEN NULL ELSE last_error END
      WHERE id = $1`,
    [id, v.name, v.site_id, v.url, v.username, v.password === undefined ? saved.password : (v.password ? seal(v.password) : ''),
      v.tls_verify, v.enabled, restart, v.kind]);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const rows = await query<DnsSourceRow>(`DELETE FROM dns_sources WHERE id = $1 RETURNING *`, [Number(req.params.id) || 0]);
  if (!rows.length) return res.status(404).json({ error: 'Source not found' });
  await dropPiholeSession(rows[0]);
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
  const password = p.value.password !== undefined ? seal(p.value.password) : saved?.password ?? '';
  try {
    const entries = await testSource({ kind: p.value.kind, url: p.value.url, username: p.value.username, password, tls_verify: p.value.tls_verify });
    res.json({ ok: true, entries });
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
