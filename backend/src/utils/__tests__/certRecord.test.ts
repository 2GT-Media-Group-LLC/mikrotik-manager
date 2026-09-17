import { readRevocation } from '../certRecord';

/**
 * The fixtures are verbatim captures from 2GT-NW-MIKROTIK10G-TEST (RouterOS
 * 7.24.4): a CA and a leaf certificate were created and signed, the payload
 * captured, the leaf revoked, and the payload captured again.
 */

const HEALTHY_LEAF: Record<string, string> = {
  '.id': '*4', name: 'mtmtest-leaf', 'common-name': 'mtmtest-leaf',
  'key-type': 'rsa', 'key-size': '2048', 'days-valid': '365',
  'invalid-before': '2026-09-17 07:49:00', 'invalid-after': '2027-09-17 07:49:00',
  'serial-number': '7E3A64302194DF73', ca: 'mtmtest-ca', trusted: 'false',
  'private-key': 'true', crl: 'false', authority: 'true', issued: 'true',
  '.repeated': '{"trusted":["false","false"]}',
};

const REVOKED_LEAF: Record<string, string> = {
  '.id': '*4', name: 'mtmtest-leaf', 'common-name': 'mtmtest-leaf',
  'key-type': 'rsa', 'key-size': '2048', 'days-valid': '365',
  'invalid-before': '2026-09-17 07:49:00', 'invalid-after': '2027-09-17 07:49:00',
  'serial-number': '7E3A64302194DF73', ca: 'mtmtest-ca', trusted: 'false',
  revoked: 'true', 'private-key': 'true', crl: 'false', authority: 'true',
  '.repeated': '{"revoked":["2026-09-17 07:49:04","true"],"trusted":["false","false"]}',
};

describe('readRevocation', () => {
  it('reads a real revoked certificate, timestamp included', () => {
    expect(readRevocation(REVOKED_LEAF)).toEqual({
      revoked: true,
      revokedAtRaw: '2026-09-17 07:49:04',
    });
  });

  it('reads a real healthy certificate as not revoked', () => {
    expect(readRevocation(HEALTHY_LEAF)).toEqual({ revoked: false, revokedAtRaw: null });
  });

  it('treats the absent field as not revoked, since there is no false value', () => {
    // Note what the healthy fixture does carry: crl=false, issued=false,
    // trusted=false. Only `revoked` is omitted rather than negated.
    expect(HEALTHY_LEAF.revoked).toBeUndefined();
    expect(readRevocation({ name: 'x' }).revoked).toBe(false);
  });

  it('still detects revocation if RouterOS swaps the order of the duplicates', () => {
    // The failure this function exists to prevent: the plain field holds a date
    // rather than "true", and a === 'true' test would call it valid.
    const swapped = {
      ...REVOKED_LEAF,
      revoked: '2026-09-17 07:49:04',
      '.repeated': '{"revoked":["true","2026-09-17 07:49:04"]}',
    };
    expect(readRevocation(swapped)).toEqual({
      revoked: true,
      revokedAtRaw: '2026-09-17 07:49:04',
    });
  });

  it('detects revocation from a bare timestamp with no boolean at all', () => {
    expect(readRevocation({ revoked: '2026-09-17 07:49:04' })).toEqual({
      revoked: true,
      revokedAtRaw: '2026-09-17 07:49:04',
    });
  });

  it('honours an explicit false, should a release start emitting one', () => {
    expect(readRevocation({ revoked: 'false' }).revoked).toBe(false);
    expect(readRevocation({ revoked: 'no' }).revoked).toBe(false);
  });

  it('accepts yes as well as true', () => {
    expect(readRevocation({ revoked: 'yes' }).revoked).toBe(true);
  });

  it('falls back to the plain field when .repeated is malformed', () => {
    expect(readRevocation({ revoked: 'true', '.repeated': 'not json' }).revoked).toBe(true);
  });

  it('ignores an empty value', () => {
    expect(readRevocation({ revoked: '' }).revoked).toBe(false);
  });

  it('does not confuse another repeated attribute for revocation', () => {
    expect(readRevocation({ name: 'x', '.repeated': '{"trusted":["false","false"]}' }).revoked)
      .toBe(false);
  });
});
