/**
 * Per-device values for SNMP contact and location (#164).
 *
 * Applying SNMP settings writes to every selected device at once. Before this,
 * contact and location were written literally, so a fleet with a distinct
 * contact per device (for example "<identity>@example.com") could not use it
 * without every device ending up with the same value.
 *
 * Blank fields also used to be written as blank, which erased the existing
 * contact and location on every device the moment someone clicked Apply
 * without filling them in. Blank now means "leave as is".
 */

export interface SnmpDeviceVars {
  identity: string;
  name: string;
  ip: string;
  model?: string | null;
  serial?: string | null;
  site?: string | null;
  location?: string | null;
}

/** Variable names, as written between braces. */
export const SNMP_VARIABLES: Record<string, keyof SnmpDeviceVars> = {
  identity: 'identity',
  name: 'name',
  ip: 'ip',
  model: 'model',
  serial: 'serial',
  site: 'site',
  location: 'location',
  // Written this way in the original request; accepted as an alias.
  $systemidentity: 'identity',
};

const PLACEHOLDER = /\{\s*(\$?[a-z_]+)\s*\}/gi;

/** Placeholders in a template that are not known variables. */
export function unknownVariables(template: string): string[] {
  const bad = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!(m[1].toLowerCase() in SNMP_VARIABLES)) bad.add(m[0]);
  }
  return [...bad];
}

/** Fill in one device's values. A variable with no value for this device becomes empty. */
export function renderSnmpTemplate(template: string, vars: SnmpDeviceVars): string {
  return template
    .replace(PLACEHOLDER, (whole, key: string) => {
      const field = SNMP_VARIABLES[key.toLowerCase()];
      if (!field) return whole;
      return String(vars[field] ?? '');
    })
    .trim();
}

/**
 * Only fields with something in them are written. An empty or whitespace-only
 * field returns undefined, which setSnmpConfig treats as "do not touch".
 */
export function fieldToWrite(value: string | undefined, vars: SnmpDeviceVars): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return renderSnmpTemplate(value, vars);
}
