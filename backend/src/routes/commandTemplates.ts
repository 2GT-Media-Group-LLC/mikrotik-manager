import { Router } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite, fleetOnly } from '../middleware/auth';
import { strictId } from '../utils/siteAccess';
import { DeviceCollector, type DeviceRow } from '../services/mikrotik/DeviceCollector';
import { captureCommands, CAPTURE_SECTIONS, CAPTURE_LABELS, type CaptureSection } from '../utils/templateCapture';

/**
 * Saved command templates (#163).
 *
 * Asked for so the same command set can be run again by tag, device or across
 * the fleet without retyping it, and later reused as post-upgrade commands.
 * A template is only text: running it still goes through Bulk Commands, with
 * waves, halt-on-failure and Change Guard exactly as a typed command does.
 */
const router = Router();
router.use(requireAuth);

const MAX_COMMAND = 10_000;

function validate(body: Record<string, unknown>, partial: boolean): { error?: string; name?: string; description?: string | null; command?: string } {
  const out: { name?: string; description?: string | null; command?: string } = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 100) return { error: 'name is required (up to 100 characters)' };
    out.name = name;
  }
  if (body.command !== undefined || !partial) {
    const command = String(body.command ?? '').replace(/\r\n/g, '\n').trim();
    if (!command) return { error: 'command is required' };
    if (command.length > MAX_COMMAND) return { error: `command is limited to ${MAX_COMMAND} characters` };
    out.command = command;
  }
  if (body.description !== undefined) {
    const d = String(body.description ?? '').trim();
    out.description = d ? d.slice(0, 1000) : null;
  }
  return out;
}

const uniqueError = (e: unknown) => (e as { code?: string }).code === '23505';

router.get('/', async (_req, res) => {
  res.json(await query(
    `SELECT id, name, description, command, created_by, created_at, updated_at
       FROM command_templates ORDER BY lower(name)`
  ));
});

// GET /command-templates/capture/sections — what a template can be captured from.
router.get('/capture/sections', (_req, res) => {
  res.json(CAPTURE_SECTIONS.map((key) => ({ key, label: CAPTURE_LABELS[key] })));
});

// GET /command-templates/capture?deviceId=&sections=dns,ntp — a draft template
// from a configured device (Discussion #85). Nothing is saved: the page opens
// it to check and edit first. For the same people who can save templates.
router.get('/capture', requireWrite, fleetOnly, async (req, res) => {
  const id = strictId(req.query.deviceId);
  if (!id) return res.status(400).json({ error: 'deviceId is required' });
  const sections = String(req.query.sections ?? '').split(',').filter(Boolean);
  const bad = sections.find((s) => !(CAPTURE_SECTIONS as readonly string[]).includes(s));
  if (bad || sections.length === 0) return res.status(400).json({ error: `sections must be some of ${CAPTURE_SECTIONS.join(', ')}` });
  const device = await queryOne<DeviceRow & { ros_version: string | null }>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const c = new DeviceCollector(device);
  let read: Awaited<ReturnType<DeviceCollector['readForCapture']>>;
  try {
    await c.connect();
    read = await c.readForCapture();
  } catch (err) {
    return res.status(502).json({ error: `Couldn't read ${device.name}: ${(err as Error).message}` });
  } finally {
    c.disconnect();
  }
  const rosMajor = parseInt(String(device.ros_version ?? '7'), 10) || 7;
  const { lines, skipped } = captureCommands({ rosMajor, ...read }, sections as CaptureSection[]);
  return res.json({
    name: `From ${device.name}`,
    description: `Captured from ${device.name}${device.ros_version ? ` (RouterOS ${device.ros_version})` : ''}: `
      + sections.map((s) => CAPTURE_LABELS[s as CaptureSection].replace(/ \(.*\)$/, '')).join(', '),
    command: lines.join('\n'),
    skipped,
  });
});

router.post('/', requireWrite, fleetOnly, async (req, res) => {
  const v = validate(req.body ?? {}, false);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const [row] = await query(
      `INSERT INTO command_templates (name, description, command, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [v.name, v.description ?? null, v.command, req.user?.username ?? null]
    );
    return res.status(201).json(row);
  } catch (e) {
    if (uniqueError(e)) return res.status(409).json({ error: 'A template with that name already exists' });
    throw e;
  }
});

router.put('/:id', requireWrite, fleetOnly, async (req, res) => {
  const v = validate(req.body ?? {}, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const k of ['name', 'description', 'command'] as const) {
    if (v[k] !== undefined) { params.push(v[k]); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    const [row] = await query(
      `UPDATE command_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`, params
    );
    if (!row) return res.status(404).json({ error: 'Template not found' });
    return res.json(row);
  } catch (e) {
    if (uniqueError(e)) return res.status(409).json({ error: 'A template with that name already exists' });
    throw e;
  }
});

router.delete('/:id', requireWrite, fleetOnly, async (req, res) => {
  const rows = await query(`DELETE FROM command_templates WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Template not found' });
  return res.json({ ok: true });
});

export default router;
