import { certExpiryState, needsAttention, describeCert } from '../certExpiry';

const NOW = new Date('2026-09-16T12:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('certExpiryState', () => {
  it('classifies against the operator-set window', () => {
    expect(certExpiryState(inDays(30), NOW, 14).state).toBe('valid');
    expect(certExpiryState(inDays(14), NOW, 14).state).toBe('expiring');
    expect(certExpiryState(inDays(1), NOW, 14).state).toBe('expiring');
    expect(certExpiryState(inDays(-1), NOW, 14).state).toBe('expired');
  });

  // The boundary is the whole point of a threshold, so it is pinned.
  it('includes the threshold day itself', () => {
    expect(certExpiryState(inDays(14), NOW, 14).state).toBe('expiring');
    expect(certExpiryState(inDays(15), NOW, 14).state).toBe('valid');
  });

  it('counts days remaining, negative once past', () => {
    expect(certExpiryState(inDays(10), NOW, 14).daysLeft).toBe(10);
    expect(certExpiryState(inDays(-3), NOW, 14).daysLeft).toBe(-3);
  });

  // "Expires today" must not read as already expired.
  it('treats the final day as expiring, not expired', () => {
    const laterToday = new Date(NOW.getTime() + 6 * 3_600_000);
    const v = certExpiryState(laterToday, NOW, 14);
    expect(v.state).toBe('expiring');
    expect(v.daysLeft).toBe(0);
  });

  /**
   * A certificate whose validity starts in the future fails connections now and
   * usually means the device clock is wrong — a different problem from expiry,
   * and one worth naming separately.
   */
  it('separates not-yet-valid from valid', () => {
    const v = certExpiryState(inDays(365), NOW, 14, inDays(5));
    expect(v.state).toBe('not-yet-valid');
  });

  it('ignores invalid-before once it has passed', () => {
    expect(certExpiryState(inDays(365), NOW, 14, inDays(-5)).state).toBe('valid');
  });

  // Silence beats a guess: an unreadable date must not alert.
  it('is unknown when there is no usable date', () => {
    for (const bad of [null, undefined, '', 'not-a-date']) {
      const v = certExpiryState(bad, NOW, 14);
      expect(v.state).toBe('unknown');
      expect(v.daysLeft).toBeNull();
      expect(needsAttention(v)).toBe(false);
    }
  });

  // A threshold of zero would otherwise make every certificate "expiring".
  it('does not warn about everything when the threshold is zero or negative', () => {
    expect(certExpiryState(inDays(30), NOW, 0).state).toBe('valid');
    expect(certExpiryState(inDays(30), NOW, -5).state).toBe('valid');
    // Genuinely expired still reports, whatever the threshold.
    expect(certExpiryState(inDays(-1), NOW, 0).state).toBe('expired');
  });

  it('accepts a string date, as stored', () => {
    expect(certExpiryState('2036-06-29T21:28:29Z', NOW, 14).state).toBe('valid');
  });
});

describe('needsAttention', () => {
  it('is true only for states someone must act on', () => {
    expect(needsAttention(certExpiryState(inDays(-1), NOW, 14))).toBe(true);
    expect(needsAttention(certExpiryState(inDays(3), NOW, 14))).toBe(true);
    expect(needsAttention(certExpiryState(inDays(365), NOW, 14, inDays(5)))).toBe(true);
    expect(needsAttention(certExpiryState(inDays(365), NOW, 14))).toBe(false);
  });
});

describe('describeCert', () => {
  const cert = { name: 'ovpn-client', common_name: 'client-42' };

  it('names the certificate, so nobody has to go looking', () => {
    const s = describeCert(cert, certExpiryState(inDays(5), NOW, 14));
    expect(s).toContain('ovpn-client');
    expect(s).toContain('client-42');
    expect(s).toContain('5 days');
  });

  it('says "today" rather than "in 0 days"', () => {
    const s = describeCert(cert, certExpiryState(new Date(NOW.getTime() + 3_600_000), NOW, 14));
    expect(s).toContain('expires today');
  });

  it('reports how long ago an expired certificate went', () => {
    expect(describeCert(cert, certExpiryState(inDays(-3), NOW, 14))).toContain('expired 3 days ago');
  });

  // A CA expiring invalidates everything it signed, not one connection.
  it('calls out a certificate authority as such', () => {
    const ca = { name: 'local-ca', is_authority: true };
    expect(describeCert(ca, certExpiryState(inDays(2), NOW, 14))).toMatch(/^Certificate authority local-ca/);
  });

  it('does not repeat the name when the common name matches', () => {
    const same = { name: 'api-ssl', common_name: 'api-ssl' };
    expect(describeCert(same, certExpiryState(inDays(2), NOW, 14))).not.toContain('(api-ssl)');
  });

  it('uses the singular for one day', () => {
    expect(describeCert(cert, certExpiryState(inDays(1), NOW, 14))).toContain('1 day');
    expect(describeCert(cert, certExpiryState(inDays(1), NOW, 14))).not.toContain('1 days');
  });
});

describe('day counting rounds towards zero in both directions', () => {
  // Observed in real output: a certificate three days and a fraction past its
  // date reported "expired 4 days ago", because Math.floor rounds a negative
  // away from zero.
  it('does not overstate how long ago something expired', () => {
    const justOverThree = new Date(NOW.getTime() - (3 * 86_400_000 + 3_600_000));
    expect(certExpiryState(justOverThree, NOW, 14).daysLeft).toBe(-3);
    expect(describeCert({ name: 'c' }, certExpiryState(justOverThree, NOW, 14)))
      .toContain('expired 3 days ago');
  });

  it('does not overstate how long is left', () => {
    const justUnderFive = new Date(NOW.getTime() + (5 * 86_400_000 - 3_600_000));
    expect(certExpiryState(justUnderFive, NOW, 14).daysLeft).toBe(4);
  });
});

/**
 * Revocation (#143).
 *
 * Reported by a user who had certificates with valid dates that he had revoked,
 * and which this showed as "Valid". Dates cannot detect that, so the flag has to
 * win over them.
 */
describe('revoked certificates', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it('overrides a date that would otherwise read as valid', () => {
    const v = certExpiryState('2027-09-17T12:00:00Z', now, 14, null, { revoked: true });
    expect(v.state).toBe('revoked');
  });

  it('overrides the warning window too', () => {
    const v = certExpiryState('2026-09-20T12:00:00Z', now, 14, null, { revoked: true });
    expect(v.state).toBe('revoked');
  });

  it('still reports days, so the list can show the original date', () => {
    const v = certExpiryState('2026-09-27T12:00:00Z', now, 14, null, { revoked: true });
    expect(v.daysLeft).toBe(10);
  });

  it('survives having no expiry date at all', () => {
    const v = certExpiryState(null, now, 14, null, { revoked: true });
    expect(v).toEqual({ state: 'revoked', daysLeft: null });
  });

  it('does not alert: the operator revoked it deliberately', () => {
    const v = certExpiryState('2027-09-17T12:00:00Z', now, 14, null, { revoked: true });
    expect(needsAttention(v)).toBe(false);
  });

  it('says so in words', () => {
    const v = certExpiryState('2027-09-17T12:00:00Z', now, 14, null, { revoked: true });
    expect(describeCert({ name: 'vpn-client', is_authority: false }, v))
      .toBe('Certificate vpn-client has been revoked');
  });

  it('a missing flag is not revoked — RouterOS omits the field entirely', () => {
    expect(certExpiryState('2027-09-17T12:00:00Z', now, 14, null, {}).state).toBe('valid');
    expect(certExpiryState('2027-09-17T12:00:00Z', now, 14, null, { revoked: null }).state).toBe('valid');
    expect(certExpiryState('2027-09-17T12:00:00Z', now, 14).state).toBe('valid');
  });

  it('leaves the truncation fix intact on the shared day helper', () => {
    // 3 days and 1 hour past: "3 days ago", not 4. Regressed once already.
    const v = certExpiryState('2026-09-14T11:00:00Z', now, 14);
    expect(v.state).toBe('expired');
    expect(v.daysLeft).toBe(-3);
  });
});
