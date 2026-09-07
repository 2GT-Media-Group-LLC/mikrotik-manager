import { readFileSync } from 'fs';
import { join } from 'path';
import { DEVICE_BASE_COLUMNS } from '../deviceColumns';

const SRC = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('DEVICE_BASE_COLUMNS', () => {
  it('includes the fields a device payload cannot be useful without', () => {
    for (const col of ['id', 'name', 'ip_address', 'status', 'device_type', 'site_id']) {
      expect(DEVICE_BASE_COLUMNS).toContain(col);
    }
  });

  /**
   * The regression this file exists for: site_id was added to the device list
   * but not to the detail read, so the Site field on the device page could not
   * see its own value. It rendered "Unassigned" and looked like it rejected
   * every change, while the writes were landing correctly.
   *
   * Every query that returns a device to a client must go through the shared
   * column list, so a field added there reaches all of them at once.
   */
  it('is used by every query that builds a device response', () => {
    for (const f of ['routes/devices.ts', 'services/deviceCreation.ts']) {
      const src = read(f);
      const selects = src.match(/`SELECT[^`]*FROM devices[^`]*`/g) ?? [];
      // A *payload* select is one whose COLUMN LIST reads display fields.
      // Inspecting the column list rather than the whole statement matters:
      // matching the full text catches WHERE clauses that merely mention
      // name or status, which is how an unrelated SSH-target query first
      // tripped this. Internal reads -- credentials for a connection,
      // existence probes, `SELECT *` for the collector -- are a different
      // thing and rightly don't carry the set.
      const columnList = (q: string) => q.slice(0, q.search(/\bFROM\b/));
      // Either already using the shared list, or hand-rolling display columns.
      // Both count as payloads; the assertion below is what separates them, so
      // a newly hand-rolled device SELECT fails rather than passing unnoticed.
      const payloadSelects = selects.filter((q) => {
        const cols = columnList(q);
        if (/SELECT \*/.test(cols)) return false;
        return cols.includes('DEVICE_BASE_COLUMNS')
          || (/\bname\b/.test(cols) && /\bstatus\b/.test(cols));
      });
      expect(payloadSelects.length).toBeGreaterThan(0);
      for (const q of payloadSelects) {
        expect(columnList(q)).toContain('DEVICE_BASE_COLUMNS');
        // Free guard while we are here: a payload must never carry a secret.
        expect(columnList(q)).not.toMatch(/_encrypted/);
      }
    }
  });
});
