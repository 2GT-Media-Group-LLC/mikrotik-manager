/**
 * Reading revocation out of a RouterOS `/certificate/print detail` row.
 *
 * This is a separate function with its own tests because the field does not
 * behave like the others, and the difference was only found by creating a CA on
 * a test switch, signing a certificate, revoking it and capturing both payloads.
 * Guessing the shape would have produced something that looked right and
 * reported every revoked certificate as valid.
 *
 * Two things are unusual about it.
 *
 * **The field is absent unless the certificate is revoked.** Sibling booleans
 * are always present and spelled out — a healthy certificate carries
 * `crl=false`, `issued=false`, `trusted=false`. `revoked` is simply not there.
 * So absence means "not revoked", and there is no false value to test for.
 *
 * **It arrives twice.** RouterOS emits the attribute once as the revocation
 * timestamp and once as a boolean:
 *
 *     revoked=2026-09-17 07:49:04
 *     revoked=true
 *
 * Our client keeps the last occurrence and preserves the rest under `.repeated`.
 * Reading `row['revoked'] === 'true'` therefore works only while RouterOS emits
 * them in that order — and if it ever swapped them, the check would silently
 * read a date as "not true" and mark a revoked certificate valid. Failing that
 * way round is the expensive one, so every occurrence is considered instead.
 *
 * The timestamp is worth keeping: "revoked on 17 Sep" answers the question an
 * operator actually has when they find one still installed.
 */

export interface Revocation {
  revoked: boolean;
  /** RouterOS-formatted revocation time, if it gave one. Unparsed. */
  revokedAtRaw: string | null;
}

const NOT_REVOKED: Revocation = { revoked: false, revokedAtRaw: null };
const BOOLEAN_WORD = /^(true|false|yes|no)$/i;
const FALSEY = /^(false|no)$/i;

export function readRevocation(row: Record<string, string>): Revocation {
  const values = occurrences(row, 'revoked');
  if (values.length === 0) return NOT_REVOKED;

  // Present but explicitly negative everywhere: honour it, in case a future
  // release starts spelling the false case out like the other flags do.
  if (values.every((v) => FALSEY.test(v))) return NOT_REVOKED;

  // A timestamp is the value that is not a boolean word.
  const stamp = values.find((v) => v && !BOOLEAN_WORD.test(v));
  return { revoked: true, revokedAtRaw: stamp ?? null };
}

/**
 * Every value RouterOS sent for an attribute, including ones a later duplicate
 * overwrote.
 */
function occurrences(row: Record<string, string>, key: string): string[] {
  const out: string[] = [];

  const repeated = row['.repeated'];
  if (repeated) {
    try {
      const parsed = JSON.parse(repeated) as Record<string, unknown>;
      const list = parsed?.[key];
      if (Array.isArray(list)) out.push(...list.map((v) => String(v).trim()));
    } catch {
      // Malformed .repeated must not lose the plain field below.
    }
  }

  const direct = row[key];
  if (direct !== undefined && !out.includes(String(direct).trim())) {
    out.push(String(direct).trim());
  }

  return out.filter((v) => v.length > 0);
}
