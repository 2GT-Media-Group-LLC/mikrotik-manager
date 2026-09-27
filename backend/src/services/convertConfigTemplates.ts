import { query } from '../config/database';
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
    const conv = configTemplateToCommand(row);
    let copied = !conv;
    if (conv) {
      const base = row.name.trim().slice(0, 80) || `Config template ${row.id}`;
      const candidates = [base, `${base} (config template)`, `${base} (config template ${row.id})`];
      for (const name of candidates) {
        const inserted = await query(
          `INSERT INTO command_templates (name, description, command, created_by)
           VALUES ($1, $2, $3, 'converted') ON CONFLICT (name) DO NOTHING RETURNING id`,
          [name, conv.description, conv.command]
        );
        if (inserted.length) { converted++; copied = true; break; }
      }
    }
    if (!copied) {
      // Left unmarked so it is tried again, never silently dropped.
      console.warn(`[templates] could not convert Config Template "${row.name}": every name tried is taken`);
      continue;
    }
    // Empty templates are marked too: there is nothing to carry over.
    await query(`UPDATE config_templates SET converted_at = NOW() WHERE id = $1`, [row.id]);
  }
  if (converted) console.log(`[templates] converted ${converted} Config Template(s) into command templates`);
  return converted;
}
