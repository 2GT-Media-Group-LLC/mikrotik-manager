import { describe, it, expect } from 'vitest';
import { isCapsmanCertificate, isQuietCapsmanCertificate } from './capsmanCerts';

const cert = (common_name: string | null, state = 'valid', name = 'cert1') => ({ name, common_name, state });

describe('CAPsMAN certificates (#197)', () => {
  it('recognises the names CAPsMAN generates', () => {
    expect(isCapsmanCertificate(cert('CAPsMAN-CA-04F41CA2C459'))).toBe(true);
    expect(isCapsmanCertificate(cert('CAPsMAN-04:F4:1C:A2:C4:59'))).toBe(true);
    expect(isCapsmanCertificate(cert('CAP-04F41CA2C45A'))).toBe(true);
    expect(isCapsmanCertificate(cert(null, 'valid', 'CAP-04F41CA2C45A'))).toBe(true);
  });
  it('recognises the wifi package\'s names, with a WiFi- prefix', () => {
    // Verbatim from #197.
    expect(isCapsmanCertificate(cert('WiFi-CAPsMAN-05A36C9ACE6F'))).toBe(true);
    expect(isCapsmanCertificate(cert('WiFi-CAPsMAN-CA-DDEAFF261184'))).toBe(true);
    expect(isCapsmanCertificate(cert('WiFi-CAP-04F41CA2C45A'))).toBe(true);
    expect(isCapsmanCertificate(cert('WiFi-office'))).toBe(false);
    expect(isCapsmanCertificate(cert('WiFi-WiFi-CAP-04F41CA2C45A'))).toBe(false);
  });
  it('leaves other certificates alone', () => {
    expect(isCapsmanCertificate(cert('2GT-NW-AP4'))).toBe(false);
    expect(isCapsmanCertificate(cert('CAP-office'))).toBe(false);
    expect(isCapsmanCertificate(cert('mtm-api-ssl'))).toBe(false);
  });
  it('only hides ones that are still valid', () => {
    expect(isQuietCapsmanCertificate(cert('CAPsMAN-CA-04F41CA2C459'))).toBe(true);
    expect(isQuietCapsmanCertificate(cert('CAPsMAN-CA-04F41CA2C459', 'expired'))).toBe(false);
    expect(isQuietCapsmanCertificate(cert('CAPsMAN-CA-04F41CA2C459', 'revoked'))).toBe(false);
  });
});
