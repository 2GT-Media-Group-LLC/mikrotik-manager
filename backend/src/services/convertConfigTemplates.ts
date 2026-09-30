import { query, transaction } from '../config/database';
import { configTemplateToCommand, type OldConfigTemplate } from '../utils/configTemplateConvert';

/**
 * One-time move of Config Templates into command templates (#163). Runs at
 * startup; each row is converted once and marked, so it is safe to repeat.
 * A name already taken by a command template gets " (config template)".
 */
export async function convertConfigTemplates(): Promise<number> {
  const rows = await query<OldConfigTemplate & { id: number }>(
    `SELECT id, name, description, applies_to_type, template_json
       FROM config_templates WHERE converted_at IS NULL ORDER BY id`
  );
  let converted = 0;
  for (const row of rows) {
    // Copy and mark in one transaction, with the source row locked: stopping
    // between the two used to leave it unmarked, and the next start copied it
    // again under the next free name (outside review S10).
    const outcome = await transaction(async (client) => {
      const locked = await client.query(
        `SELECT id FROM config_templates WHERE id = $1 AND converted_at IS NULL FOR UPDATE SKIP LOCKED`, [row.id]);
      if (locked.rowCount === 0) return 'skipped' as const; // done elsewhere meanwhile
      const conv = configTemplateToCommand(row);
      let copied = !conv;
      if (conv) {
        const base = row.name.trim().slice(0, 80) || `Config template ${row.id}`;
        const candidates = [base, `${base} (config template)`, `${base} (config template ${row.id})`];
        for (const name of candidates) {
          const inserted = await client.query(
            `INSERT INTO command_templates (name, description, command, created_by)
             VALUES ($1, $2, $3, 'converted') ON CONFLICT (name) DO NOTHING RETURNING id`,
            [name, conv.description, conv.command]
          );
          if (inserted.rowCount) { copied = true; break; }
        }
      }
      if (!copied) return 'taken' as const;
      // Empty templates are marked too: there is nothing to carry over.
      await client.query(`UPDATE config_templates SET converted_at = NOW() WHERE id = $1`, [row.id]);
      return conv ? 'converted' as const : 'empty' as const;
    });
    if (outcome === 'converted') converted++;
    if (outcome === 'taken') {
      // Left unmarked so it is tried again, never silently dropped.
      console.warn(`[templates] could not convert Config Template "${row.name}": every name tried is taken`);
    }
  }
  if (converted) console.log(`[templates] converted ${converted} Config Template(s) into command templates`);
  return converted;
}
