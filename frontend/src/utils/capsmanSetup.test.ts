import { describe, it, expect } from 'vitest';
import { capsmanSsidError, capsmanPassphraseError, capsmanCountryError } from './capsmanSetup';

describe('CAPsMAN quick set checks (#438)', () => {
  it('checks the SSID as the server does', () => {
    expect(capsmanSsidError('')).toMatch(/Enter/);
    expect(capsmanSsidError('Office')).toBeNull();
    expect(capsmanSsidError('é'.repeat(17))).toMatch(/32 bytes/);
  });

  it('checks the password, and lets an existing one stay', () => {
    expect(capsmanPassphraseError('', false)).toMatch(/Enter/);
    expect(capsmanPassphraseError('', true)).toBeNull();
    expect(capsmanPassphraseError('short', false)).toMatch(/8 to 63/);
    expect(capsmanPassphraseError('correct horse', false)).toBeNull();
    expect(capsmanPassphraseError('ab'.repeat(32), false)).toBeNull();
  });

  it('takes a country name or nothing', () => {
    expect(capsmanCountryError('')).toBeNull();
    expect(capsmanCountryError('United States')).toBeNull();
    expect(capsmanCountryError('x;y')).toMatch(/country/);
  });
});
