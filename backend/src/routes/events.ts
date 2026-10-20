import { Router, Request, Response } from 'express';
import { roleAtLeast, roleOnDevice } from '../utils/siteAccess';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeByNullableDevice } from '../utils/siteScope';
import { activeSite, writableScope } from '../middleware/site';
import { CLOCK_CHANGE_SQL } from '../utils/clockLogLines';
import { parseFirewallLog } from '../utils/firewallLogParser';

/** Most events the list's total counts; past it the page shows "N+". */
export const EVENTS_COUNT_CAP = 100_000;

const router = Router();
router.use(requireAuth);

// GET /api/events
/**
 * GET /api/events/topics — the distinct RouterOS topic tokens in use, with counts.
 *
 * RouterOS reports a topic as a comma-separated list such as `system,info,account`,
 * so the useful unit of filtering is the individual token rather than the whole
 * string. Splitting server-side keeps the badge list honest across the entire table
 * instead of only the page currently loaded (issue #108).
 */
router.get('/topics', async (req: Request, res: Response) => {
  const siteFilter = siteScopeByNullableDevice(activeSite(req), 'device_id');
  const rows = await query<{ token: string; n: string }>(`
    SELECT token, COUNT(*) AS n
    FROM (
      SELECT unnest(string_to_array(topic, ',')) AS token
      FROM events
      WHERE topic IS NOT NULL AND topic <> ''
        AND event_time > NOW() - INTERVAL '30 days'
        ${siteFilter ? `AND ${siteFilter}` : ''}
    ) t
    WHERE btrim(token) <> ''
    GROUP BY token
    ORDER BY COUNT(*) DESC, token ASC
    LIMIT 40`);
  res.json(rows.map((r) => ({ topic: r.token.trim(), count: Number(r.n) })));
});


type FirewallEventRow = {
  id: number;
  device_id: number | null;
  severity: string;
  topic: string | null;
  message: string;
  event_time: Date | string;
  device_name: string | null;
};

const DEFAULT_FIREWALL_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIREWALL_MAX_LIMIT = 200;

const FIREWALL_ACTION_REGEX = {
  fasttrack: String.raw`\m(fasttrack|fast-track)\M`,
  drop: String.raw`\m(drop|deny|denied|block|blocked)\M`,
  reject: String.raw`\mreject(ed)?\M`,
  accept: String.raw`\m(accept|accepted|allow|allowed|permit|permitted)\M`,
} as const;

const FIREWALL_ACTIONS = new Set([
  'accept',
  'drop',
  'reject',
  'fasttrack',
  'unknown',
]);

function singleQueryValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function strictInteger(
  value: string,
  min: number,
  max?: number
): number | null {
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < min) return null;
  if (max !== undefined && parsed > max) return null;

  return parsed;
}

// GET /api/events/firewall
router.get('/firewall', async (req: Request, res: Response) => {
  const deviceIdRaw = singleQueryValue(req.query.deviceId);
  const sinceRaw = singleQueryValue(req.query.since);
  const searchRaw = singleQueryValue(req.query.search);
  const actionRaw = singleQueryValue(req.query.action);
  const protocolRaw = singleQueryValue(req.query.protocol);
  const limitRaw = singleQueryValue(req.query.limit);
  const offsetRaw = singleQueryValue(req.query.offset);

  if (deviceIdRaw === null) {
    return res.status(400).json({ error: 'Invalid deviceId' });
  }
  if (sinceRaw === null) {
    return res.status(400).json({ error: 'Invalid since' });
  }
  if (searchRaw === null) {
    return res.status(400).json({ error: 'Invalid search' });
  }
  if (actionRaw === null) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  if (protocolRaw === null) {
    return res.status(400).json({ error: 'Invalid protocol' });
  }
  if (limitRaw === null) {
    return res.status(400).json({ error: 'Invalid limit' });
  }
  if (offsetRaw === null) {
    return res.status(400).json({ error: 'Invalid offset' });
  }

  const deviceId =
    deviceIdRaw === undefined
      ? undefined
      : strictInteger(deviceIdRaw, 1);

  if (deviceIdRaw !== undefined && deviceId === null) {
    return res.status(400).json({ error: 'Invalid deviceId' });
  }

  const requestedLimit =
    limitRaw === undefined
      ? 100
      : strictInteger(limitRaw, 1, FIREWALL_MAX_LIMIT);

  if (requestedLimit === null) {
    return res.status(400).json({
      error: `Invalid limit; expected an integer from 1 to ${FIREWALL_MAX_LIMIT}`,
    });
  }

  const requestedOffset =
    offsetRaw === undefined
      ? 0
      : strictInteger(offsetRaw, 0);

  if (requestedOffset === null) {
    return res.status(400).json({
      error: 'Invalid offset; expected a non-negative integer',
    });
  }

  const sinceDate =
    sinceRaw === undefined
      ? new Date(Date.now() - DEFAULT_FIREWALL_WINDOW_MS)
      : new Date(sinceRaw);

  if (Number.isNaN(sinceDate.getTime())) {
    return res.status(400).json({
      error: 'Invalid since; expected a valid date/time',
    });
  }

  const actionFilter = actionRaw?.trim().toLowerCase() ?? '';

  if (actionFilter && !FIREWALL_ACTIONS.has(actionFilter)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const protocolFilter = protocolRaw?.trim().toLowerCase() ?? '';

  if (
    protocolFilter &&
    !/^[a-z0-9_-]{1,32}$/.test(protocolFilter)
  ) {
    return res.status(400).json({ error: 'Invalid protocol' });
  }

  const filters: string[] = [
    `'firewall' = ANY(string_to_array(e.topic, ','))`,
    `e.message ~* '(input|forward|output):'`,
    `e.message ~* '(^|[[:space:],])proto[[:space:]]+'`,
    `e.message LIKE '%->%'`,
  ];

  const params: unknown[] = [];
  let idx = 1;

  filters.push(`e.event_time >= $${idx++}`);
  params.push(sinceDate.toISOString());

  if (deviceId !== undefined) {
    filters.push(`e.device_id = $${idx++}`);
    params.push(deviceId);
  }

  const siteFilter = siteScopeByNullableDevice(
    activeSite(req),
    'e.device_id'
  );
  if (siteFilter) filters.push(siteFilter);

  const searchTerm = searchRaw?.trim();

  if (searchTerm) {
    filters.push(
      `(e.message ILIKE $${idx} OR COALESCE(d.name, '') ILIKE $${idx})`
    );
    params.push(`%${searchTerm}%`);
    idx++;
  }

  // RouterOS packet logs place the configured log-prefix before the chain.
  // Restrict action matching to that prefix so words elsewhere in the packet
  // details do not change the inferred action.
  const prefixSql = `COALESCE(
    NULLIF(split_part(e.message, ' input:', 1), e.message),
    NULLIF(split_part(e.message, ' forward:', 1), e.message),
    NULLIF(split_part(e.message, ' output:', 1), e.message),
    ''
  )`;

  const addActionMatch = (
    pattern: string,
    negate = false
  ) => {
    filters.push(
      `${prefixSql} ${negate ? '!~*' : '~*'} $${idx++}`
    );
    params.push(pattern);
  };

  if (actionFilter === 'fasttrack') {
    addActionMatch(FIREWALL_ACTION_REGEX.fasttrack);
  } else if (actionFilter === 'drop') {
    addActionMatch(FIREWALL_ACTION_REGEX.fasttrack, true);
    addActionMatch(FIREWALL_ACTION_REGEX.drop);
  } else if (actionFilter === 'reject') {
    addActionMatch(FIREWALL_ACTION_REGEX.fasttrack, true);
    addActionMatch(FIREWALL_ACTION_REGEX.drop, true);
    addActionMatch(FIREWALL_ACTION_REGEX.reject);
  } else if (actionFilter === 'accept') {
    addActionMatch(FIREWALL_ACTION_REGEX.fasttrack, true);
    addActionMatch(FIREWALL_ACTION_REGEX.drop, true);
    addActionMatch(FIREWALL_ACTION_REGEX.reject, true);
    addActionMatch(FIREWALL_ACTION_REGEX.accept);
  } else if (actionFilter === 'unknown') {
    addActionMatch(FIREWALL_ACTION_REGEX.fasttrack, true);
    addActionMatch(FIREWALL_ACTION_REGEX.drop, true);
    addActionMatch(FIREWALL_ACTION_REGEX.reject, true);
    addActionMatch(FIREWALL_ACTION_REGEX.accept, true);
  }

  if (protocolFilter) {
    filters.push(`e.message ~* $${idx++}`);
    params.push(
      String.raw`\mproto[[:space:]]+${protocolFilter}([[:space:](,]|$)`
    );
  }

  const where = filters.join(' AND ');

  const rowsQuery = query<FirewallEventRow>(
    `SELECT
       e.id,
       e.device_id,
       e.severity,
       e.topic,
       e.message,
       e.event_time,
       d.name AS device_name
     FROM events e
     LEFT JOIN devices d ON d.id = e.device_id
     WHERE ${where}
     ORDER BY e.event_time DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, requestedLimit, requestedOffset]
  );

  const countQuery = query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM events e
     LEFT JOIN devices d ON d.id = e.device_id
     WHERE ${where}`,
    params
  );

  const [rows, totalRows] = await Promise.all([
    rowsQuery,
    countQuery,
  ]);

  // SQL has already narrowed and paged the result. Node only parses the
  // rows that are actually returned to this request.
  const events = rows.flatMap((row) => {
    const event = parseFirewallLog(row.message);
    if (!event) return [];

    return [{
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      eventTime: row.event_time,
      severity: row.severity,
      topic: row.topic,
      rawMessage: row.message,
      ...event,
    }];
  });

  res.json({
    events,
    total: Number(totalRows[0]?.total ?? 0),
  });
});

router.get('/', async (req: Request, res: Response) => {
  const {
    deviceId,
    severity,
    topic,
    search,
    since,
    limit = '200',
    offset = '0',
    clock,
  } = req.query;

  const filters: string[] = ['1=1'];
  const params: unknown[] = [];
  let idx = 1;

  if (deviceId) {
    filters.push(`e.device_id = $${idx++}`);
    params.push(deviceId);
  }
  // Events with no device belong to no site, so they are hidden while a site is
  // selected rather than repeated into every one of them (issue #130).
  const siteFilter = siteScopeByNullableDevice(activeSite(req), 'e.device_id');
  if (siteFilter) filters.push(siteFilter);
  // Same predicate for the unaliased critical-count query below.
  const siteFilterBare = siteScopeByNullableDevice(activeSite(req), 'device_id');
  if (severity) {
    // Accept comma-separated list e.g. "error,warning"
    // 'error' also includes 'critical' rows
    const requested = String(severity).split(',').map((s) => s.trim()).filter(Boolean);
    const expanded = new Set<string>();
    for (const s of requested) {
      expanded.add(s);
      if (s === 'error') expanded.add('critical');
    }
    const placeholders = Array.from(expanded).map(() => `$${idx++}`).join(',');
    filters.push(`e.severity IN (${placeholders})`);
    params.push(...Array.from(expanded));
  }
  if (topic) {
    // Match a whole token rather than a substring: the badges present topics as
    // discrete tags, so `error` must not also match a hypothetical `no-error`.
    filters.push(`$${idx++} = ANY(string_to_array(e.topic, ','))`);
    params.push(topic);
  }
  if (since) {
    filters.push(`e.event_time >= $${idx++}`);
    params.push(since);
  }
  if (search) {
    filters.push(`(e.message ILIKE $${idx} OR e.topic ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  // Clock adjustments are hidden unless ?clock=1 (#213). Rows stored before
  // they were reclassified as info are hidden the same way.
  if (clock !== '1') filters.push(`NOT ${CLOCK_CHANGE_SQL.replace('message', 'e.message')}`);

  const where = filters.join(' AND ');

  const rowsQuery = query(
    `SELECT e.*, d.name as device_name
     FROM events e
     LEFT JOIN devices d ON d.id = e.device_id
     WHERE ${where}
     ORDER BY e.event_time DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, parseInt(String(limit), 10), parseInt(String(offset), 10)]
  );

  // ?counts=0 returns the rows alone. The dashboard shows five events and never reads
  // the totals, and the total is a regex test over every stored event, several seconds
  // on a large table that also slowed whatever else the database was doing.
  if (req.query.counts === '0') {
    res.json({ events: await rowsQuery });
    return;
  }

  const [events, totalResult, criticalCount] = await Promise.all([
    rowsQuery,
    // Counted up to one past the cap, then stopped: an exact total meant testing every
    // stored event (millions on a busy install), several seconds on every refresh.
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM (SELECT 1 FROM events e WHERE ${where} LIMIT ${EVENTS_COUNT_CAP + 1}) c`,
      params
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM events
       WHERE severity IN ('error','critical') AND event_time > NOW() - INTERVAL '24 hours'
         AND NOT ${CLOCK_CHANGE_SQL}
         ${siteFilterBare ? `AND ${siteFilterBare}` : ''}`
    ),
  ]);

  const counted = parseInt(totalResult[0]?.count || '0', 10);
  res.json({
    events,
    total: Math.min(counted, EVENTS_COUNT_CAP),
    // True when there are more than EVENTS_COUNT_CAP matching events (total is the cap).
    totalCapped: counted > EVENTS_COUNT_CAP,
    criticalCount: parseInt(criticalCount[0]?.count || '0', 10),
  });
});

// DELETE /api/events (clear events for a device or all)
router.delete('/', requireWrite, async (req: Request, res: Response) => {
  const { deviceId } = req.query;
  if (deviceId) {
    if (!roleAtLeast(await roleOnDevice(req.user!, Number(deviceId)), 'operator')) {
      return res.status(404).json({ error: 'Device not found' });
    }
    await query(`DELETE FROM events WHERE device_id = $1`, [deviceId]);
  } else {
    // Only the events in view: clearing while a site is selected used to
    // delete the whole fleet's, and a site-scoped account only clears sites it
    // operates (P1-7).
    const scope = siteScopeByNullableDevice(writableScope(req), 'device_id');
    await query(`DELETE FROM events ${scope ? `WHERE ${scope}` : ''}`);
  }
  return res.json({ message: 'Events cleared' });
});

export default router;
