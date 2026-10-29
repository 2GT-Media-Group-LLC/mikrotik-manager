/**
 * The parts of a device's security checklist that come from our own records
 * rather than from the device, and the score (#371).
 *
 * The fleet view caches each device's checklist for a while (#302). The
 * "update available" findings come from the device row, which the poller and
 * firmware upgrades keep current, so the fleet view rebuilds them from the
 * row on every read. A cached copy said ten devices needed an update after
 * nine of them had been upgraded, while the Firmware page said one.
 */

export type PostureSev = 'high' | 'medium' | 'low';
export type PostureCheck = {
  id: string; severity: PostureSev; title: string; detail: string;
  serviceId?: string; fix?: 'api-ssl' | 'www-ssl' | 'api-off' | 'romon';
};
export type MarkedCheck = PostureCheck & { suppressed?: true; suppressed_scope?: 'device' | 'fleet'; suppressed_reason?: string | null };
export interface Suppression { check_id: string; device_id: number | null; reason: string | null }

export interface UpdateColumns {
  ros_version?: string | null;
  firmware_update_available?: boolean | null;
  latest_ros_version?: string | null;
  routerboard_upgrade_available?: boolean | null;
  firmware_version?: string | null;
  upgrade_firmware_version?: string | null;
}

/** Check ids built from the device row, not read from the device. */
export const UPDATE_CHECK_IDS = new Set(['firmware-outdated', 'routerboot-outdated']);

/**
 * Pending RouterOS and RouterBOOT updates. Outdated firmware is a security
 * exposure: RouterOS releases routinely ship security fixes. Titles stay
 * version-free so the Security page's common findings group devices on
 * different versions into one row.
 */
export function updateChecks(d: UpdateColumns): PostureCheck[] {
  const out: PostureCheck[] = [];
  if (d.firmware_update_available && d.latest_ros_version) {
    out.push({
      id: 'firmware-outdated', severity: 'medium',
      title: 'RouterOS update available',
      detail: `This device runs RouterOS ${d.ros_version || '(unknown)'} but ${d.latest_ros_version} is available. RouterOS releases regularly include security fixes — review the changelog and schedule the upgrade from the Firmware section.`,
    });
  }
  if (d.routerboard_upgrade_available) {
    out.push({
      id: 'routerboot-outdated', severity: 'low',
      title: 'RouterBOOT upgrade pending',
      detail: `The bootloader (${d.firmware_version || 'current'}) has an available upgrade${d.upgrade_firmware_version ? ` to ${d.upgrade_firmware_version}` : ''}. Apply it after the next RouterOS upgrade from the device's Config tab.`,
    });
  }
  return out;
}

/**
 * Mark muted checks (#101) and score the rest. A muted finding stays visible,
 * greyed, and stops counting; a device-specific mute wins over a fleet-wide
 * one so the UI can offer the narrower undo. Graduated weights with a floor of
 * 5, so it never reads a hard 0: a relative hardening indicator, not a grade.
 */
export function markAndScore(checks: PostureCheck[], deviceId: number, supp: Suppression[]): { score: number; checks: MarkedCheck[] } {
  const suppressedBy = new Map<string, { scope: 'device' | 'fleet'; reason: string | null }>();
  for (const row of supp) {
    if (row.device_id !== null && row.device_id !== deviceId) continue;
    const scope = row.device_id == null ? 'fleet' : 'device';
    if (scope === 'device' || !suppressedBy.has(row.check_id)) suppressedBy.set(row.check_id, { scope, reason: row.reason });
  }
  const marked: MarkedCheck[] = checks.map((c) => {
    const hit = suppressedBy.get(c.id);
    return hit ? { ...c, suppressed: true, suppressed_scope: hit.scope, suppressed_reason: hit.reason } : c;
  });
  const WEIGHT: Record<PostureSev, number> = { high: 15, medium: 7, low: 3 };
  const counted = marked.filter((c) => !c.suppressed);
  const penalty = counted.reduce((n, c) => n + WEIGHT[c.severity], 0);
  return { score: counted.length === 0 ? 100 : Math.max(5, 100 - penalty), checks: marked };
}

/** A cached checklist with its update findings rebuilt from the current device row. */
export function withCurrentUpdates(cached: MarkedCheck[], device: UpdateColumns & { id: number }, supp: Suppression[]) {
  const fromDevice = cached
    .filter((c) => !UPDATE_CHECK_IDS.has(c.id))
    .map(({ suppressed: _s, suppressed_scope: _sc, suppressed_reason: _r, ...c }) => c);
  return markAndScore([...fromDevice, ...updateChecks(device)], device.id, supp);
}
