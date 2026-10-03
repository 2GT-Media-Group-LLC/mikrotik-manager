import { query, queryOne } from '../config/database';
import { alertService } from './AlertService';
import { fleetCveReport } from './cveFeed';
import { cveAlertsFor, cveAlertMessage } from '../utils/cveAlerts';

const ALERTED_KEY = 'cve_alerted';

/**
 * Announce serious CVEs newly affecting the fleet (#224). Run after the CVE
 * feed refreshes. The pairs already announced are kept only while the rule is
 * on, so turning it on later announces what applies at that point.
 */
export async function checkCveAlerts(): Promise<number> {
  const rule = await queryOne<{ enabled: boolean }>(`SELECT enabled FROM alert_rules WHERE event_type = 'cve_active'`);
  if (!rule?.enabled) return 0;
  const stored = await queryOne<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [ALERTED_KEY]);
  const alerted = new Set(Array.isArray(stored?.value) ? (stored!.value as string[]) : []);
  const { items, current } = cveAlertsFor(await fleetCveReport(null), alerted);
  if (items.length > 0) {
    const { message, details } = cveAlertMessage(items);
    // Its own cooldown key per batch: a second, different batch in a day is news.
    await alertService.dispatch('cve_active', message, { details, cooldownKey: `cve_active:${current.join(',')}` });
  }
  // Pairs whose version left the fleet drop out, so they'd be announced again
  // if it came back.
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [ALERTED_KEY, JSON.stringify(current)]
  );
  return items.reduce((n, i) => n + i.cves.length, 0);
}
