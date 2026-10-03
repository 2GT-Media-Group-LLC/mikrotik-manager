/**
 * Certificates CAPsMAN generates for itself and its CAPs (#197): common names
 * "CAPsMAN-CA-<mac>", "CAPsMAN-<mac>" and "CAP-<mac>", valid until 2038. They
 * renew nothing and need no attention while valid, so the certificate lists
 * hide them by default. One that isn't valid any more is always shown.
 */
const CAPSMAN_CN = /^(CAPsMAN-CA-|CAPsMAN-|CAP-)([0-9A-F]{2}[:-]?){5}[0-9A-F]{2}$/i;

export function isCapsmanCertificate(c: { name: string; common_name: string | null }): boolean {
  return CAPSMAN_CN.test((c.common_name || c.name || '').trim());
}

/** A CAPsMAN certificate that can be hidden: it's still valid. */
export function isQuietCapsmanCertificate(c: { name: string; common_name: string | null; state: string }): boolean {
  return c.state === 'valid' && isCapsmanCertificate(c);
}
