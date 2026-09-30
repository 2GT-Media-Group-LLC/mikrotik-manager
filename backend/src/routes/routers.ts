import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { maskSecretsForReadOnly } from '../utils/redactSecrets';
import { siteScopeDevices } from '../utils/siteScope';
import { activeSite, writableScope } from '../middleware/site';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import { getLldpStatuses, setLldpForTypes } from '../services/lldpApply';
import { applySnmpConfig, getSnmpStatuses, SnmpInputError, type SnmpConfigInput } from '../services/snmpApply';

const router = Router();
router.use(requireAuth);
// Viewers and read-only tokens never receive device secrets (Wi-Fi keys,
// WireGuard private keys, SNMP communities, hotspot passwords).
router.use(maskSecretsForReadOnly);

// GET /api/routers/lldp — LLDP status per online router in the active site.
// Kept for API callers; the UI uses /api/network-services/lldp, which covers
// every device type.
router.get('/lldp', async (req: Request, res: Response) => {
  res.json(await getLldpStatuses(['router'], activeSite(req)));
});

// PUT /api/routers/lldp — enable or disable LLDP on online routers in the active site
router.put('/lldp', requireWrite, async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '"enabled" (boolean) is required' });
  }
  return res.json(await setLldpForTypes(['router'], enabled, writableScope(req)));
});

// GET /api/routers/snmp — SNMP config/status per online router
router.get('/snmp', async (req: Request, res: Response) => {
  // Kept for existing API users; the page uses /api/network-services/snmp,
  // which covers every device type.
  res.json(await getSnmpStatuses(activeSite(req), ['router']));
});

// PUT /api/routers/snmp — apply SNMP config to all online routers
router.put('/snmp', requireWrite, async (req: Request, res: Response) => {
  // See services/snmpApply.ts: per-device variables, blanks left alone, and
  // only the active site's devices.
  try {
    return res.json(await applySnmpConfig({ all: true, deviceTypes: ['router'] }, req.body as SnmpConfigInput, writableScope(req)));
  } catch (e) {
    if (e instanceof SnmpInputError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

export default router;
