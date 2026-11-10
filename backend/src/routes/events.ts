import { Router } from 'express';
import { roleAtLeast, roleOnDevice } from '../utils/siteAccess';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeByNullableDevice } from '../utils/siteScope';
import { activeSite, writableScope } from '../middleware/site';
import { CLOCK_CHANGE_SQL } from '../utils/clockLogLines';
import { parseFirewallLog } from '../utils/firewallLogParser';
import { firewallPacketLogSql } from '../utils/firewallEventSql';
import { withNames, withZones } from '../services/firewallLogEnrich';

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
router.get('/topics', async (req, res) => {
  const siteFilter = siteScopeByNullableDevice(activeSite(req), 'device_id');
  const includeFirewall = req.query.firewall === '1';

  const rows = await query<{ token: string; n: string }>(`
    SELECT token, COUNT(*) AS n
    FROM (
      SELECT unnest(string_to_array(topic, ',')) AS token
      FROM events
      WHERE topic IS NOT NULL AND topic <> ''
        AND event_time > NOW() - INTERVAL '30 days'
        ${includeFirewall ? '' : `AND NOT ${firewallPacketLogSql()}`}
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

/** Grouping reads at most this many of the newest matching lines. */
export const FIREWALL_GROUP_SCAN = 100_000;

type FirewallGroupRow = {
  device_id: number | null;
  device_name: string | null;
  dst_port: string | null;
  n: string;
  first_seen: Date | string;
  last_seen: Date | string;
  sample: string;
  total_groups: string;
};

/**
 * The firewall log folded the way a next-generation firewall shows it (#415):
 * one line per device, rule (log prefix), chain, interfaces, protocol, source,
 * destination and destination port, with a count and first and last time.
 * The source port is left out on purpose: a blocked client retrying, or a
 * scan, is one line instead of hundreds.
 */
async function groupedFirewall(
  where: string, baseParams: unknown[], firstIdx: number, joinDevices: boolean, limit: number, offset: number, names: boolean,
) {
  const params = [...baseParams];
  let idx = firstIdx;
  const p = (v: unknown) => { params.push(v); return `$${idx++}`; };
  const prefixRe = p('^(.*?) (input|forward|output):');
  const chainRe = p('(input|forward|output):');
  const inRe = p(' in:([^ ,]+)');
  const outRe = p(' out:([(]unknown 0[)]|[^ ,]+)');
  const protoRe = p('proto ([A-Za-z0-9-]+)');
  const epRe = p(', ([[][^]]+[]]|[0-9.]+)(?::[0-9]+)?->([[][^]]+[]]|[0-9.]+)(?::([0-9]+))?');
  const scan = p(FIREWALL_GROUP_SCAN);
  const lim = p(limit);
  const off = p(offset);
  const rows = await query<FirewallGroupRow>(
    `WITH m AS (
       SELECT e.device_id, e.event_time, e.message,
              substring(e.message from ${prefixRe}) AS prefix,
              substring(e.message from ${chainRe}) AS chain,
              substring(e.message from ${inRe}) AS in_if,
              substring(e.message from ${outRe}) AS out_if,
              upper(substring(e.message from ${protoRe})) AS proto,
              regexp_match(e.message, ${epRe}) AS ep
         FROM events e
         ${joinDevices ? 'LEFT JOIN devices d ON d.id = e.device_id' : ''}
        WHERE ${where}
        ORDER BY e.event_time DESC, e.id DESC
        LIMIT ${scan}
     ), g AS (
       SELECT device_id, prefix, chain, in_if, out_if, proto, ep[1] AS src, ep[2] AS dst, ep[3] AS dst_port,
              COUNT(*) AS n, MIN(event_time) AS first_seen, MAX(event_time) AS last_seen,
              (array_agg(message ORDER BY event_time DESC))[1] AS sample
         FROM m
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
     )
     SELECT g.device_id, d.name AS device_name, g.dst_port, g.n::text AS n, g.first_seen, g.last_seen, g.sample,
            (COUNT(*) OVER ())::text AS total_groups
       FROM g LEFT JOIN devices d ON d.id = g.device_id
      ORDER BY g.last_seen DESC, g.n DESC
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  const groups = rows.flatMap((r) => {
    const event = parseFirewallLog(r.sample);
    if (!event) return [];
    return [{
      deviceId: r.device_id,
      deviceName: r.device_name,
      count: Number(r.n),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      rawMessage: r.sample,
      ...event,
      // Folded over every source port; the destination port is the group's.
      srcPort: undefined,
      dstPort: r.dst_port != null ? Number(r.dst_port) : undefined,
    }];
  });
  const zoned = await withZones(groups);
  return {
    groups: names ? await withNames(zoned) : zoned,
    total: Number(rows[0]?.total_groups ?? 0), scanLimit: FIREWALL_GROUP_SCAN,
  };
}

// GET /api/events/firewall[?view=grouped]
router.get('/firewall', async (req, res) => {
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
    firewallPacketLogSql('e'),
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
  // ?names=1 (#415): hostnames and reverse DNS in place of addresses.
  const names = singleQueryValue(req.query.names) === '1';

  if (req.query.view === 'grouped') {
    return res.json(await groupedFirewall(where, params, idx, !!searchTerm, requestedLimit, requestedOffset, names));
  }

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
     ORDER BY e.event_time DESC, e.id DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, requestedLimit, requestedOffset]
  );

  const countQuery = query<{ total: string }>(
    // The join is only needed when the search can match a device name. Without
    // it the count is an index-only scan of the firewall partial index; with a
    // needless LEFT JOIN it has to visit the heap for every matching row.
    `SELECT COUNT(*)::text AS total
     FROM events e
     ${searchTerm ? 'LEFT JOIN devices d ON d.id = e.device_id' : ''}
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

  const zoned = await withZones(events);
  res.json({
    events: names ? await withNames(zoned) : zoned,
    total: Number(totalRows[0]?.total ?? 0),
  });
});

router.get('/', async (req, res) => {
  const {
    deviceId,
    severity,
    topic,
    search,
    since,
    limit = '200',
    offset = '0',
    clock,
    firewall,
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

  // Firewall packet logs have their own page and can be extremely high-volume.
  // Keep them out of Device Logs unless explicitly requested.
  if (firewall !== '1') {
    filters.push(`NOT ${firewallPacketLogSql('e')}`);
  }

  const where = filters.join(' AND ');

  // Page size is clamped so a crafted ?limit= can never ask the server (or the
  // browser) to materialise more than one screenful's worth of rows.
  const parsedLimit = parseInt(String(limit), 10);
  const parsedOffset = parseInt(String(offset), 10);
  const pageLimit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 1000)
    : 200;
  const pageOffset = Number.isFinite(parsedOffset)
    ? Math.max(parsedOffset, 0)
    : 0;

  const rowsQuery = query(
    // Named columns only: `e.*` dragged raw_json (a full copy of the RouterOS
    // log object) through the wire for every row, which the page never reads.
    // id is the tie-breaker so events written in the same batch keep a stable
    // order across pages instead of duplicating or skipping rows.
    `SELECT e.id, e.device_id, e.event_time, e.severity, e.topic, e.message,
            d.name as device_name
     FROM events e
     LEFT JOIN devices d ON d.id = e.device_id
     WHERE ${where}
     ORDER BY e.event_time DESC, e.id DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, pageLimit, pageOffset]
  );

  // ?counts=0 returns the rows alone. The dashboard shows five events and never reads
  // the totals, so it should not pay for the two aggregates below.
  if (req.query.counts === '0') {
    res.json({ events: await rowsQuery });
    return;
  }

  const [events, totalResult, criticalCount] = await Promise.all([
    rowsQuery,
    // Counted up to one past the cap, then stopped. The partial index added for
    // the default view makes this an index-only scan over the rows the page can
    // actually show instead of a regex test over every stored event.
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM (SELECT 1 FROM events e WHERE ${where} LIMIT ${EVENTS_COUNT_CAP + 1}) c`,
      params
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM events
       WHERE severity IN ('error','critical') AND event_time > NOW() - INTERVAL '24 hours'
         AND NOT ${CLOCK_CHANGE_SQL}
         ${firewall === '1' ? '' : `AND NOT ${firewallPacketLogSql()}`}
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

// DELETE /api/events/firewall
// Clear only RouterOS firewall packet logs, with the same device/site scope as
// the generic event clear endpoint.
router.delete('/firewall', requireWrite, async (req, res) => {
  const deviceIdRaw = singleQueryValue(req.query.deviceId);

  if (deviceIdRaw === null) {
    return res.status(400).json({ error: 'Invalid deviceId' });
  }

  const deviceId =
    deviceIdRaw === undefined
      ? undefined
      : strictInteger(deviceIdRaw, 1);

  if (deviceIdRaw !== undefined && deviceId === null) {
    return res.status(400).json({ error: 'Invalid deviceId' });
  }

  const filters: string[] = [firewallPacketLogSql()];
  const params: unknown[] = [];

  if (deviceId != null) {
    if (!roleAtLeast(await roleOnDevice(req.user!, deviceId), 'operator')) {
      return res.status(404).json({ error: 'Device not found' });
    }

    filters.push(`device_id = $1`);
    params.push(deviceId);
  } else {
    const scope = siteScopeByNullableDevice(
      writableScope(req),
      'device_id'
    );

    if (scope) filters.push(scope);
  }

  const deleted = await query<{ count: string }>(
    `WITH deleted AS (
      DELETE FROM events
        WHERE ${filters.join(' AND ')}
        RETURNING 1
    )
    SELECT COUNT(*)::text AS count FROM deleted`,
    params
  );

  return res.json({
    message: 'Firewall events cleared',
    deleted: parseInt(deleted[0]?.count || '0', 10),
  });
});

// DELETE /api/events (clear events for a device or all)
router.delete('/', requireWrite, async (req, res) => {
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
