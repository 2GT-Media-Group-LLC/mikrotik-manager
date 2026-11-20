/**
 * Fixes from the 1.1 security review's CodeQL pass: linear parsing where a
 * regex backtracked, and an unbiased secret alphabet.
 */
import { pemBlocks } from '../pemBundle';
import { parseRosVersion } from '../rosVersion';
import { generateSecret } from '../../services/commandSecrets';

const quick = (f: () => unknown) => {
  const start = Date.now();
  try { f(); } catch { /* the error is fine; the time is the point */ }
  return Date.now() - start;
};

describe('pemBlocks', () => {
  const block = (label: string, body = 'QUJD') => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
  it('reads blocks as before', () => {
    expect(pemBlocks(`${block('CERTIFICATE')}\n${block('CERTIFICATE', 'REVG')}\n`).map((b) => b.label)).toEqual(['CERTIFICATE', 'CERTIFICATE']);
    expect(pemBlocks(block('PRIVATE KEY').replace(/\n/g, '\r\n'))[0].pem).toBe(block('PRIVATE KEY'));
    expect(pemBlocks('  \n')).toEqual([]);
  });
  it('refuses text outside the blocks, a header with no line break, and a block with no END', () => {
    expect(() => pemBlocks(`junk\n${block('CERTIFICATE')}`)).toThrow('outside');
    expect(() => pemBlocks(`${block('CERTIFICATE')}\njunk`)).toThrow('outside');
    expect(() => pemBlocks('-----BEGIN CERTIFICATE-----QUJD\n-----END CERTIFICATE-----')).toThrow('outside');
    expect(() => pemBlocks('-----BEGIN CERTIFICATE-----\nQUJD\n-----END KEY-----')).toThrow('outside');
    expect(() => pemBlocks('-----BEGIN bad label-----\nQUJD\n-----END bad label-----')).toThrow('outside');
  });
  it('is quick on a field of BEGIN lines with no END', () => {
    expect(quick(() => pemBlocks('-----BEGIN A-----\n'.repeat(200_000)))).toBeLessThan(500);
  });
});

describe('parseRosVersion', () => {
  it('still reads versions with a channel', () => {
    expect(parseRosVersion('7.25beta3 (stable)')).toEqual({ parts: [7, 25], preRank: expect.any(Number), preNum: 3 });
    expect(parseRosVersion('7.25.1 (stable)')?.parts).toEqual([7, 25, 1]);
  });
  it('is quick on whatever a device sends', () => {
    expect(quick(() => parseRosVersion(`7.1${' '.repeat(200_000)}x`))).toBeLessThan(200);
    expect(quick(() => parseRosVersion(`7.1 ${'('.repeat(200_000)}`))).toBeLessThan(200);
  });
});

describe('generateSecret', () => {
  it('uses only the alphabet, at the length asked', () => {
    const s = generateSecret(500);
    expect(s).toHaveLength(500);
    expect(s).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
  });
});
