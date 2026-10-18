jest.mock('../../config/database');
jest.mock('../AlertService', () => ({ alertService: { dispatch: jest.fn() } }));

import { X509Certificate } from 'crypto';
import { createCa, issueDeviceCert } from '../../utils/pki';
import { verifyManagedCertificate, adoptCaCertificate, forgetCachedCa } from '../deviceCa';
import { IdentityMismatchError } from '../identityPins';
import { query, queryOne } from '../../config/database';

jest.setTimeout(30_000);
const mockedQueryOne = jest.mocked(queryOne);
const mockedQuery = jest.mocked(query);

describe('connection check for devices with a certificate from the manager CA (#200)', () => {
  let caPem: string;
  let goodRaw: Buffer;
  let goodFp: string;
  let rogueRaw: Buffer;
  let rogueFp: string;

  beforeAll(async () => {
    const ca = await createCa({ commonName: 'Fleet CA', days: 3650 });
    caPem = ca.certPem;
    const good = await issueDeviceCert({ ca, commonName: 'sw1', sans: ['10.0.0.5'], days: 365 });
    goodRaw = new X509Certificate(good.certPem).raw;
    goodFp = good.fingerprint;
    // Same name and address, signed by a different CA.
    const other = await createCa({ commonName: 'Fleet CA', days: 3650 });
    const rogue = await issueDeviceCert({ ca: other, commonName: 'sw1', sans: ['10.0.0.5'], days: 365 });
    rogueRaw = new X509Certificate(rogue.certPem).raw;
    rogueFp = rogue.fingerprint;
  });

  /** db: the managed row for 10.0.0.5:8729 (or none), and the CA row. */
  function db(managedFp: string | null): void {
    forgetCachedCa();
    mockedQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes('FROM managed_device_certs')) return managedFp ? { device_id: 1, name: 'sw1', fingerprint: managedFp } : null;
      if (sql.includes('FROM device_ca')) return { cert_pem: caPem };
      return null;
    }) as never);
  }

  it('lets through a device that is not enrolled, without looking at the CA', async () => {
    db(null);
    await expect(verifyManagedCertificate('10.0.0.5', 8729, rogueRaw)).resolves.toBeUndefined();
  });

  it('accepts the certificate the CA issued', async () => {
    db(goodFp);
    await expect(verifyManagedCertificate('10.0.0.5', 8729, goodRaw)).resolves.toBeUndefined();
  });

  it('refuses a certificate recorded for the device but not signed by the CA', async () => {
    db(rogueFp);
    await expect(verifyManagedCertificate('10.0.0.5', 8729, rogueRaw)).rejects.toBeInstanceOf(IdentityMismatchError);
  });
});

describe('adopting a CA certificate the manager has no record of (restored older backup)', () => {
  let caPem: string;
  let renewed: { raw: Buffer; fp: string };
  let otherAddress: Buffer;
  let foreign: Buffer;

  beforeAll(async () => {
    const ca = await createCa({ commonName: 'Fleet CA', days: 3650 });
    caPem = ca.certPem;
    const r = await issueDeviceCert({ ca, commonName: 'sw1', sans: ['10.0.0.5', 'sw1.lan'], days: 365 });
    renewed = { raw: new X509Certificate(r.certPem).raw, fp: r.fingerprint };
    otherAddress = new X509Certificate((await issueDeviceCert({ ca, commonName: 'sw2', sans: ['10.0.0.9'], days: 365 })).certPem).raw;
    const other = await createCa({ commonName: 'Fleet CA', days: 3650 });
    foreign = new X509Certificate((await issueDeviceCert({ ca: other, commonName: 'sw1', sans: ['10.0.0.5'], days: 365 })).certPem).raw;
  });

  function db(device: { managed_fp: string | null; pinned: string | null }) {
    forgetCachedCa();
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([] as never);
    mockedQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes('LEFT JOIN managed_device_certs')) return { device_id: 1, name: 'sw1', ip_address: '10.0.0.5', ...device };
      if (sql.includes('FROM device_ca')) return { cert_pem: caPem, default_www: true };
      return null;
    }) as never);
  }
  const writes = () => mockedQuery.mock.calls.map((c) => String(c[0]).trim().split(/\s+/).slice(0, 3).join(' '));

  it('takes up a renewed certificate for an enrolled device: record and pin updated, no alarm', async () => {
    db({ managed_fp: 'a'.repeat(64), pinned: 'a'.repeat(64) });
    await adoptCaCertificate('10.0.0.5', 8729, renewed.raw);
    expect(writes()).toEqual(expect.arrayContaining(['UPDATE managed_device_certs SET', 'INSERT INTO device_identity_pins']));
    const pin = mockedQuery.mock.calls.find((c) => String(c[0]).includes('device_identity_pins'))!;
    expect(pin[1]).toEqual([1, renewed.fp]);
  });

  it('enrols a device that was enrolled after the backup was made', async () => {
    db({ managed_fp: null, pinned: 'b'.repeat(64) });
    await adoptCaCertificate('10.0.0.5', 8729, renewed.raw);
    expect(writes()).toEqual(expect.arrayContaining(['INSERT INTO managed_device_certs', 'INSERT INTO device_identity_pins']));
  });

  it('leaves alone a certificate from another CA, one for another address, and a device already in step', async () => {
    db({ managed_fp: 'a'.repeat(64), pinned: 'a'.repeat(64) });
    await adoptCaCertificate('10.0.0.5', 8729, foreign);
    await adoptCaCertificate('10.0.0.5', 8729, otherAddress);
    db({ managed_fp: renewed.fp, pinned: renewed.fp });
    await adoptCaCertificate('10.0.0.5', 8729, renewed.raw);
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
