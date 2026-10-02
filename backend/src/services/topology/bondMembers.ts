/**
 * Bond members per device, for spanning-tree analysis (outside review J6). A
 * bridge whose root port is a bond learns its neighbours on the member ports,
 * so the upstream is looked up through them. Members come from the bond's
 * interface record (config_json.slaves), filled in by interface collection.
 */
import { query } from '../../config/database';

export async function loadBondMembers(): Promise<Map<string, string[]>> {
  const rows = await query<{ device_id: number; name: string; slaves: string | null }>(
    `SELECT device_id, name, config_json->>'slaves' AS slaves FROM interfaces WHERE type = 'bond'`
  ).catch(() => []);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const members = (r.slaves ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    if (members.length > 0) out.set(`${r.device_id} ${r.name}`, members);
  }
  return out;
}
