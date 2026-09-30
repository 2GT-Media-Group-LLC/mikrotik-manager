import { connectPreferringSsl, describeSslFailure } from '../mikrotik/apiConnect';
import { enableApiSsl, MTM_CERT_NAME, type ApiSslDevice } from '../apiSsl';
import { RouterOSClient } from '../mikrotik/RouterOSClient';
import { query } from '../../config/database';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../utils/crypto', () => ({ decrypt: (v: string) => v, encrypt: (v: string) => v }));
jest.mock('../mikrotik/RouterOSClient');

const MockClient = RouterOSClient as jest.MockedClass<typeof RouterOSClient>;
const mockQuery = query as jest.MockedFunction<typeof query>;

type Exec = (cmd: string, params?: Record<string, string>, queries?: string[]) => Promise<Record<string, string>[]>;

/** Make every client built for `port` connect (or fail) and answer `exec`. */
function clients(behaviour: Record<number, { connect?: () => Promise<void>; exec?: Exec }>) {
  const calls: Array<{ port: number; cmd: string; params?: Record<string, string> }> = [];
  (MockClient as unknown as jest.Mock).mockImplementation((_host: string, port: number) => {
    const b = behaviour[port] ?? {};
    return {
      connect: jest.fn(b.connect ?? (() => Promise.resolve())),
      disconnect: jest.fn(),
      execute: jest.fn(async (cmd: string, params?: Record<string, string>, queries?: string[]) => {
        calls.push({ port, cmd, params });
        return b.exec ? b.exec(cmd, params, queries) : [];
      }),
    } as unknown as RouterOSClient;
  });
  return calls;
}

beforeEach(() => { jest.clearAllMocks(); mockQuery.mockResolvedValue([]); });

describe('connectPreferringSsl', () => {
  it('uses API-SSL when it answers', async () => {
    clients({});
    const r = await connectPreferringSsl('10.0.0.1', 'u', 'p');
    expect(r.port).toBe(8729);
    expect(r.sslError).toBeUndefined();
  });

  it('falls back to the plain API, saying why', async () => {
    clients({ 8729: { connect: () => Promise.reject(new Error('Connection refused')) } });
    const r = await connectPreferringSsl('10.0.0.1', 'u', 'p');
    expect(r.port).toBe(8728);
    expect(r.sslError).toBeTruthy();
  });

  it('explains the common reasons API-SSL is unavailable in plain words', () => {
    expect(describeSslFailure(new Error('error:0A000410:SSL routines:ssl3_read_bytes:ssl/tls alert handshake failure:SSL alert number 40')))
      .toMatch(/no certificate/);
    expect(describeSslFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toMatch(/turned off/);
    expect(describeSslFailure(new Error('Connection timeout to 10.0.0.1:8729'))).toMatch(/firewall/);
  });

  it("reports the plain API's error when neither works", async () => {
    clients({
      8729: { connect: () => Promise.reject(new Error('Connection refused')) },
      8728: { connect: () => Promise.reject(new Error('invalid user name or password')) },
    });
    await expect(connectPreferringSsl('10.0.0.1', 'u', 'p')).rejects.toThrow(/invalid user name/);
  });
});

describe('enableApiSsl', () => {
  const device: ApiSslDevice = {
    id: 8, name: 'sw1', ip_address: '10.0.0.8', api_port: 8728, api_username: 'admin', api_password_encrypted: 'pw',
  };
  const signedCert = { '.id': '*C', name: MTM_CERT_NAME, 'private-key': 'true', expired: 'false' };

  it('creates and signs a certificate, enables api-ssl, and switches after a TLS login', async () => {
    // Lookups of the manager's certificate: none yet, then unsigned, then signed.
    let lookups = 0;
    let signed = false;
    const calls = clients({
      8728: {
        exec: async (cmd) => {
          if (cmd === '/ip/service/print') return [{ '.id': '*S', name: 'api-ssl', port: '8729', disabled: 'true', certificate: 'none' }];
          if (cmd === '/certificate/print') {
            lookups++;
            if (lookups === 1) return [];
            return signed ? [signedCert] : [{ '.id': '*C', name: MTM_CERT_NAME, 'private-key': 'false' }];
          }
          if (cmd === '/certificate/sign') { signed = true; return []; }
          if (cmd === '/system/identity/print') return [{ name: 'sw1' }];
          return [];
        },
      },
    });

    const r = await enableApiSsl(device);
    expect(r.switched).toBe(true);
    const add = calls.find((c) => c.cmd === '/certificate/add');
    expect(add?.params).toMatchObject({ name: MTM_CERT_NAME, 'key-size': '2048' });
    expect(calls.find((c) => c.cmd === '/certificate/sign')?.params).toEqual({ '.id': '*C' });
    const set = calls.find((c) => c.cmd === '/ip/service/set');
    expect(set?.params).toMatchObject({ '.id': '*S', certificate: MTM_CERT_NAME, disabled: 'no' });
    expect(calls.some((c) => c.port === 8729 && c.cmd === '/system/identity/print')).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringMatching(/UPDATE devices SET api_port/), [8729, 8]);
  });

  it('keeps a usable certificate already on api-ssl', async () => {
    const calls = clients({
      8728: {
        exec: async (cmd) => {
          if (cmd === '/ip/service/print') return [{ '.id': '*S', name: 'api-ssl', port: '8729', disabled: 'false', certificate: 'mycert' }];
          if (cmd === '/certificate/print') return [{ '.id': '*M', name: 'mycert', 'private-key': 'true' }];
          return [];
        },
      },
    });
    const r = await enableApiSsl(device);
    expect(r.switched).toBe(true);
    expect(calls.some((c) => c.cmd === '/certificate/add')).toBe(false);
    expect(calls.some((c) => c.cmd === '/ip/service/set')).toBe(false);
  });

  it('stays on the plain API when the TLS login fails, and says why', async () => {
    clients({
      8728: {
        exec: async (cmd) => {
          if (cmd === '/ip/service/print') return [{ '.id': '*S', name: 'api-ssl', port: '8729', disabled: 'false', certificate: 'mycert' }];
          if (cmd === '/certificate/print') return [{ '.id': '*M', name: 'mycert', 'private-key': 'true' }];
          return [];
        },
      },
      8729: { connect: () => Promise.reject(new Error('Connection timeout to 10.0.0.8:8729')) },
    });
    const r = await enableApiSsl(device);
    expect(r.switched).toBe(false);
    expect(r.message).toMatch(/firewall/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does nothing for a device already on API-SSL', async () => {
    clients({});
    const r = await enableApiSsl({ ...device, api_port: 8729 });
    expect(r.switched).toBe(false);
    expect(MockClient).not.toHaveBeenCalled();
  });
});
