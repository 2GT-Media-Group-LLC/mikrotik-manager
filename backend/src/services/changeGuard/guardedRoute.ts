/**
 * Route helper for device writes that run under Change Guard.
 *
 * Shared by every router that changes device configuration, so the prediction,
 * the confirm-past-a-warning handling and the response shape are the same
 * wherever a change could cut the manager off (outside review P2-8).
 */
import type { Request, Response } from 'express';
import { queryOne } from '../../config/database';
import { DeviceCollector, type DeviceRow } from '../mikrotik/DeviceCollector';
import { captureSnapshot } from './pathModel';
import { analyzeChange, type PlannedChange } from './analyzeChange';
import { withSafeApply, GuardRequiredError, type GuardDevice } from './ChangeGuard';
import { logSafe } from '../../utils/logSafe';

/**
 * Run a device mutation under the Change Guard safety net (see
 * services/changeGuard/ChangeGuard.ts): the device saves a restore point and arms
 * a self-restore before the change, and disarms it only once we prove the device
 * is still reachable. Used for changes that can sever the manager's own path.
 *
 * The response always carries a `guard` block so the UI can say whether the change
 * was confirmed, is being auto-reverted, or ran unprotected.
 */
export async function withGuardedChange<T>(
  id: string | number,
  req: Request,
  res: Response,
  meta: {
    kind: string; summary: string; change?: PlannedChange;
    /** Seconds before the device restores itself; for slow multi-step changes. */
    timeoutSec?: number;
  },
  fn: (c: DeviceCollector) => Promise<T>,
  afterConfirmed?: (c: DeviceCollector) => Promise<void>
): Promise<void> {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!deviceRow) { res.status(404).json({ error: 'Device not found' }); return; }

  // Pre-flight: simulate the change against live state and refuse a predicted
  // lockout unless the user has explicitly accepted it.
  //
  // Whenever this is anything short of a clean "safe" (a warning, a lockout the
  // user confirmed past, or an analysis that could not run), the change also
  // requires auto-revert: if the device cannot arm it, the change is refused
  // rather than applied with no way back. An analysis failure still does not
  // block a change on its own; it just means the safety net is not optional.
  // `force` is the firewall form's older name for the same thing; DELETE has no
  // body, so it can come as ?confirm_lockout=true.
  const confirmedLockout = req.body?.confirm_lockout === true || req.body?.force === true
    || req.query?.confirm_lockout === 'true';
  let requireProtection = confirmedLockout;
  if (meta.change && !confirmedLockout) {
    try {
      const snap = await captureSnapshot(deviceRow as unknown as GuardDevice);
      const verdict = analyzeChange(snap, deviceRow as unknown as GuardDevice, meta.change);
      if (verdict.severity !== 'safe') requireProtection = true;
      if (verdict.severity === 'critical') {
        res.status(409).json({
          lockout: true,
          reason: verdict.headline,
          verdict: {
            severity: verdict.severity,
            headline: verdict.headline,
            violations: verdict.violations,
            warnings: verdict.warnings,
            path: {
              mgmt_interface: verdict.path.mgmtInterface,
              bridge: verdict.path.bridge,
              mgmt_vlan_id: verdict.path.mgmtVlanId,
              tagged_management: verdict.path.taggedManagement,
              ingress_port: verdict.path.ingressPort,
              ingress_port_source: verdict.path.ingressPortSource,
              hops: verdict.path.hops,
            },
          },
        });
        return;
      }
    } catch (err) {
      requireProtection = true;
      console.warn(`[preflight] analysis skipped for device ${logSafe(id)}: ${logSafe((err as Error).message)}`);
    }
  }

  const collector = new DeviceCollector(deviceRow);
  try {
    const outcome = await withSafeApply(
      deviceRow as unknown as GuardDevice,
      { ...meta, userId: req.user?.userId ?? null, requireProtection },
      async () => {
        await collector.connect();
        return fn(collector);
      }
    );

    // Only re-read the device once we know it's still reachable.
    if (outcome.confirmed && afterConfirmed) {
      await afterConfirmed(collector).catch(() => { /* best effort */ });
    }

    res.json({
      ...(typeof outcome.result === 'object' && outcome.result !== null
        ? outcome.result as Record<string, unknown>
        : { result: outcome.result }),
      // A change that severed the connection produces no result — the request never
      // got a reply. Say what is happening rather than returning a bare guard block.
      ...(outcome.result === undefined && outcome.autoReverting
        ? { message: 'Contact with the device was lost while applying this change. It is restoring itself and should come back shortly.' }
        : {}),
      guard: {
        protected: !outcome.unprotectedReason,
        confirmed: outcome.confirmed,
        auto_reverting: outcome.autoReverting,
        unprotected_reason: outcome.unprotectedReason ?? null,
        revert_may_fire_at: outcome.revertMayFireAt ?? null,
      },
    });
  } catch (err) {
    if (err instanceof GuardRequiredError) {
      res.status(422).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  } finally {
    try { collector.disconnect(); } catch { /* device may be gone */ }
  }
}

