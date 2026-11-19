/**
 * Fuzzing the device id the site check reads against the one the route
 * handler gets. Express decodes the path for req.params; Postgres then reads
 * the id as an integer, trimming spaces and taking a sign. If any spelling of
 * a path reaches a handler naming device N while the check saw no device, or
 * another one, a site-scoped account can reach a device outside its sites
 * (GHSA-6xq3-q9m5-7hxp, GHSA-j9x4-qwcj-p8v8, GHSA-4rjj-7mfg-vrpg).
 */
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { deviceIdParam, strictId, strictIdList, guardIdParams } from '../siteAccess';
import { decodedPath } from '../requestPath';
import { fuzz, FUZZ_RUNS, FUZZ_TIMEOUT_MS, HTTP_RUNS } from '../../test/fuzz';

jest.setTimeout(FUZZ_TIMEOUT_MS);

/** The integer Postgres reads from text for an int column, or null (PostgreSQL 15 int4in). */
export function pgInt(v: string): number | null {
  const m = /^[ \t\n\r\f\v]*([+-]?\d+)[ \t\n\r\f\v]*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Path segments that might read as a number somewhere: digits, signs, spaces, encodings, look-alikes. */
const piece = fc.oneof(
  fc.integer({ min: 0, max: 99 }).map(String),
  fc.constantFrom('20', '020', '+', '-', ' ', '%20', '%2B', '%2D', '%09', '%0A', '%0B', '%0C', '%0D', '%32', '%30', '.', '..', '%2E',
    '0x', 'e', 'E', 'n', '_', '%EF%BC%92', '%D9%A2', '%C2%A0', 'a', 'A', '%25', '%2F', '%3B', ';', ',', '%00', '%', '%zz'),
);
const segment = fc.array(piece, { minLength: 1, maxLength: 6 }).map((p) => p.join(''));
const rest = fc.constantFrom('', '/', '/ports', '/PORTS', '/ports/', '/backups/1', '//ports');

function app() {
  const seen: { checked?: number | null; handled?: string } = {};
  const a = express();
  const r = express.Router();
  // As the device routers do (devices, wireless, user manager, config
  // history): the id parameter is digits or "not found", before any handler.
  // deviceIdParam alone passes " 20" as no device, which Postgres reads as 20;
  // the guard is what refuses it. The Postgres fuzz test runs the real routers.
  guardIdParams(r, ['id'], 'Device not found');
  // As deviceSiteAccess does: NaN is refused, null passes with no device, a number is checked.
  r.use((req, res, next) => {
    const id = deviceIdParam(req);
    seen.checked = id;
    if (Number.isNaN(id)) { res.status(400).end(); return; }
    next();
  });
  const handler = (req: express.Request, res: express.Response) => { seen.handled = String(req.params.id); res.status(200).end(); };
  r.get('/:id', handler);
  r.get('/:id/ports', handler);
  r.get('/:id/backups/:n', handler);
  a.use('/api/devices', r);
  return { a, seen };
}

describe('site check id fuzz', () => {
  it('strictId takes only plain positive ids, and reads them as Postgres would', () => {
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 14 }), segment, fc.integer(), fc.double(), fc.anything()), (raw) => {
      const id = strictId(raw);
      if (id === null) return;
      expect(Number.isSafeInteger(id) && id > 0 && id <= 2147483647).toBe(true);
      if (typeof raw === 'string') {
        expect(raw).toMatch(/^\d+$/);
        expect(pgInt(raw)).toBe(id);
      }
    }), fuzz());
    fc.assert(fc.property(fc.integer({ min: 1, max: 2147483647 }), (n) => {
      expect(strictId(n)).toBe(n);
      expect(strictId(String(n))).toBe(n);
    }), fuzz());
    fc.assert(fc.property(fc.array(fc.oneof(fc.integer(), fc.string({ maxLength: 4 }))), (raw) => {
      const ids = strictIdList(raw);
      if (ids !== null) expect(ids).toEqual(raw.map((v) => strictId(v)));
    }), fuzz());
  });

  it('decodedPath never throws, and reads the path the way Express routes it', () => {
    fc.assert(fc.property(fc.array(segment, { maxLength: 4 }), (segs) => {
      const path = `/${segs.join('/')}`;
      const out = decodedPath({ path });
      if (out !== null) expect(out).toBe(out.toLowerCase());
    }), fuzz());
  });

  it('a handler only ever gets a device id the site check saw', async () => {
    const { a, seen } = app();
    await fc.assert(fc.asyncProperty(segment, rest, async (seg, tail) => {
      delete seen.checked; delete seen.handled;
      const res = await request(a).get(`/api/devices/${seg}${tail}`);
      if (seen.handled === undefined) return;
      expect(res.status).toBe(200);
      const target = pgInt(seen.handled);
      // The handler would read device `target`: the check must have checked that very id.
      if (target !== null && target > 0) {
        expect({ path: `/api/devices/${seg}${tail}`, param: seen.handled, checked: seen.checked }).toEqual({ path: `/api/devices/${seg}${tail}`, param: seen.handled, checked: target });
      }
    }), fuzz({ numRuns: Math.min(FUZZ_RUNS, HTTP_RUNS) }));
  });
});
