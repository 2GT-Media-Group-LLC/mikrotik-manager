import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { deviceSiteAccess } from '../utils/siteAccess';
import { query } from '../config/database';
import type { DeviceRow } from '../services/mikrotik/DeviceCollector';
import { antennaAlignment, AlignmentCapacityError } from '../services/AntennaAlignmentService';
import { safeConnectionError } from '../utils/safeClientError';

const router = Router();

function validDeviceId(req: Request, res: Response, next: NextFunction): void {
  const id = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) {
    res.status(400).json({ error: 'Invalid device ID' });
    return;
  }
  next();
}

// Mounted by the wireless router. Check auth and device access on every read,
// including cache hits, before opening or reusing a device connection.
router.get('/:id/alignment', requireAuth, validDeviceId, deviceSiteAccess(req => Number(req.params.id)), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  res.setHeader('Cache-Control', 'no-store');
  const rows = await query<DeviceRow>('SELECT * FROM devices WHERE id = $1', [id]);
  const device = rows[0];
  if (!device) { antennaAlignment.remove(id); return res.status(404).json({ error: 'Device not found' }); }
  if (device.device_type !== 'wisp') {
    antennaAlignment.remove(id);
    return res.status(400).json({ error: 'Antenna aligner is only available for Wireless Systems devices.' });
  }
  if (device.ssh_only) {
    antennaAlignment.remove(id);
    return res.status(409).json({ error: 'Enable the RouterOS API for this Wireless Systems device before using the antenna aligner.' });
  }
  try {
    return res.json(await antennaAlignment.read(device));
  } catch (err) {
    if (err instanceof AlignmentCapacityError) return res.status(503).json({ error: err.message });
    return res.status(502).json({ error: safeConnectionError('Antenna aligner', err) });
  }
});

export default router;
