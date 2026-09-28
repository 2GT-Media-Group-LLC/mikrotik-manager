import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { maskSecretsForReadOnly } from '../utils/redactSecrets';
import { siteScopeDevices } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import { getLldpStatuses, setLldpForTypes } from '../services/lldpApply';
import { applySnmpConfig, getSnmpStatuses, SnmpInputError, type SnmpConfigInput } from '../services/snmpApply';

const router = Router();
router.use(requireAuth);
// Viewers and read-only tokens never receive device secrets (Wi-Fi keys,
// WireGuard private keys, SNMP communities, hotspot passwords).
router.use(maskSecretsForReadOnly);

// GET /api/switches — all switch devices with port statistics
router.get('/', async (req: Request, res: Response) => {
  const siteFilter = siteScopeDevices(activeSite(req), 'd');
  const switches = await query(`
    SELECT d.id, d.name, d.ip_address, d.model, d.device_type, d.status, d.last_seen,
           d.ros_version, d.firmware_version, d.serial_number, d.rack_name, d.rack_slot,
           COUNT(i.id) FILTER (WHERE i.running = true  AND i.disabled = false) AS ports_up,
           COUNT(i.id) FILTER (WHERE i.running = false AND i.disabled = false) AS ports_down,
           COUNT(i.id) FILTER (WHERE i.disabled = true)                        AS ports_disabled,
           COUNT(i.id)                                                          AS ports_total
    FROM devices d
    LEFT JOIN interfaces i ON i.device_id = d.id
      AND (i.type ILIKE 'ether%' OR i.type ILIKE 'sfp%'
           OR i.name ILIKE 'ether%' OR i.name ILIKE 'sfp%')
    WHERE d.device_type = 'switch' ${siteFilter ? `AND ${siteFilter}` : ''}
    GROUP BY d.id
    ORDER BY d.name ASC
  `);
  res.json(switches);
});

// GET /api/switches/lldp — LLDP status per online switch in the active site.
// Kept for API callers; the UI uses /api/network-services/lldp, which covers
// every device type.
router.get('/lldp', async (req: Request, res: Response) => {
  res.json(await getLldpStatuses(['switch'], activeSite(req)));
});

// PUT /api/switches/lldp — enable or disable LLDP on online switches in the active site
router.put('/lldp', requireWrite, async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '"enabled" (boolean) is required' });
  }
  return res.json(await setLldpForTypes(['switch'], enabled, activeSite(req)));
});

// GET /api/switches/snmp — SNMP config/status for all managed switches
// Includes offline/unknown devices so the list never disappears during a poll cycle.
// Unreachable devices fall through to the Promise.allSettled error path and render with an error note.
router.get('/snmp', async (req: Request, res: Response) => {
  // Kept for existing API users; the page uses /api/network-services/snmp,
  // which covers every device type.
  res.json(await getSnmpStatuses(activeSite(req), ['switch']));
});

// PUT /api/switches/snmp — apply SNMP config to all online switches
router.put('/snmp', requireWrite, async (req: Request, res: Response) => {
  // See services/snmpApply.ts: per-device variables, blanks left alone, and
  // only the active site's devices.
  try {
    return res.json(await applySnmpConfig({ all: true, deviceTypes: ['switch'] }, req.body as SnmpConfigInput, activeSite(req)));
  } catch (e) {
    if (e instanceof SnmpInputError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

export default router;
