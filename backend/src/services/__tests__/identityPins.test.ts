import {
  verifyDeviceIdentity, IdentityMismatchError, normalizeFingerprint, sshFingerprintDisplay, trustNewIdentity,
} from '../identityPins';
import { query } from '../../config/database';
import { alertService } from '../AlertService';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../AlertService', () => ({ alertService: { dispatch: jest.fn() } }));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockDispatch = alertService.dispatch as jest.Mock;

const FP_A = 'aa'.repeat(32);
const FP_B = 'bb'.repeat(32);

/** The pin lookup returns `rows`; every write after it succeeds. */
function lookupReturns(rows: Array<Record<string, unknown>>) {
  mockQuery.mockReset();
  mockQuery.mockResolvedValueOnce(rows as never).mockResolvedValue([] as never);
}
const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());

beforeEach(() => jest.clearAllMocks());

// Outside review P1-4.
describe('verifyDeviceIdentity', () => {
  it('lets through an address the manager does not manage yet (a device being added)', async () => {
    lookupReturns([]);
    await expect(verifyDeviceIdentity('api-tls', '10.0.0.1', 8729, FP_A)).resolves.toBeUndefined();
    expect(sqlCalls()).toHaveLength(1);
  });

  it('pins the first identity it sees', async () => {
    lookupReturns([{ device_id: 7, name: 'sw', fingerprint: null, seen_fingerprint: null }]);
    await verifyDeviceIdentity('api-tls', '10.0.0.1', 8729, FP_A);
    expect(sqlCalls()[1]).toMatch(/^INSERT INTO device_identity_pins/);
    expect(mockQuery.mock.calls[1][1]).toEqual([7, 'api-tls', FP_A]);
  });

  it('accepts the pinned identity', async () => {
    lookupReturns([{ device_id: 7, name: 'sw', fingerprint: FP_A, seen_fingerprint: null }]);
    await expect(verifyDeviceIdentity('api-tls', '10.0.0.1', 8729, FP_A)).resolves.toBeUndefined();
    expect(sqlCalls()).toHaveLength(1);
  });

  it('refuses a different identity, records it, and alerts once', async () => {
    lookupReturns([{ device_id: 7, name: 'sw', fingerprint: FP_A, seen_fingerprint: null }]);
    await expect(verifyDeviceIdentity('api-tls', '10.0.0.1', 8729, FP_B)).rejects.toBeInstanceOf(IdentityMismatchError);
    expect(sqlCalls().some((q) => /SET seen_fingerprint = \$3/.test(q))).toBe(true);
    expect(sqlCalls().some((q) => /INSERT INTO events/.test(q))).toBe(true);
    expect(mockDispatch).toHaveBeenCalledWith('device_identity_changed', expect.stringMatching(/certificate has changed/), expect.anything());

    // The same changed identity again: still refused, not alerted again.
    mockDispatch.mockClear();
    lookupReturns([{ device_id: 7, name: 'sw', fingerprint: FP_A, seen_fingerprint: FP_B }]);
    await expect(verifyDeviceIdentity('api-tls', '10.0.0.1', 8729, FP_B)).rejects.toBeInstanceOf(IdentityMismatchError);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('clears a recorded change once the pinned identity is back', async () => {
    lookupReturns([{ device_id: 7, name: 'sw', fingerprint: FP_A, seen_fingerprint: FP_B }]);
    await verifyDeviceIdentity('api-tls', '10.0.0.1', 8729, FP_A);
    expect(sqlCalls()[1]).toMatch(/SET seen_fingerprint = NULL/);
  });

  it('matches the SSH port for host keys', async () => {
    lookupReturns([]);
    await verifyDeviceIdentity('ssh-host', '10.0.0.1', 2222, FP_A);
    expect(sqlCalls()[0]).toMatch(/COALESCE\(d\.ssh_port, 22\) = \$3/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['ssh-host', '10.0.0.1', 2222]);
  });

  it('names the device and what to do in the refusal', async () => {
    lookupReturns([{ device_id: 7, name: 'core-sw', fingerprint: FP_A, seen_fingerprint: null }]);
    await expect(verifyDeviceIdentity('ssh-host', '10.0.0.1', 22, FP_B)).rejects.toThrow(/core-sw.*SSH host key.*Trust new host key/s);
  });
});

describe('fingerprints', () => {
  it('normalises OpenSSL and RouterOS formats alike', () => {
    expect(normalizeFingerprint('AA:BB:CC')).toBe('aabbcc');
    expect(normalizeFingerprint('aabbcc')).toBe('aabbcc');
  });

  it('shows SSH host keys the way ssh-keygen does', () => {
    expect(sshFingerprintDisplay('00'.repeat(32))).toBe('SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });
});

describe('trustNewIdentity', () => {
  it('promotes the changed identity to the pin', async () => {
    mockQuery.mockReset().mockResolvedValueOnce([{ device_id: 7 }] as never);
    expect(await trustNewIdentity(7, 'api-tls')).toBe(true);
    expect(sqlCalls()[0]).toMatch(/SET fingerprint = seen_fingerprint/);
  });

  it('reports when nothing is waiting', async () => {
    mockQuery.mockReset().mockResolvedValueOnce([] as never);
    expect(await trustNewIdentity(7, 'ssh-host')).toBe(false);
  });
});
