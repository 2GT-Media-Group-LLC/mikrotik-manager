import tls from 'tls';
import { X509Certificate } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { RouterOSClient } from '../RouterOSClient';

/**
 * Certificate pinning must refuse a device before the login is sent (outside
 * review P1-4). A local TLS server stands in for the device and records every
 * byte it receives after the handshake.
 *
 * The certificate is generated per run rather than committed, so no private
 * key lives in the repository. Skipped where openssl isn't installed.
 */
function makeCert(): { key: string; cert: string } | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'mtm-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=mtm-test',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    return { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pair = makeCert();
const maybe = pair ? describe : describe.skip;

maybe('RouterOSClient TLS pinning', () => {
  let server: tls.Server;
  let port: number;
  let received: Buffer[];

  beforeAll(async () => {
    server = tls.createServer({ key: pair!.key, cert: pair!.cert }, (sock) => {
      sock.on('data', (d: Buffer | string) => received.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => { received = []; });
  afterEach(() => { RouterOSClient.tlsVerifier = null; });

  it('sends nothing, not even the login, when the verifier refuses the certificate', async () => {
    let seen = '';
    RouterOSClient.tlsVerifier = async (_h, _p, fp) => { seen = fp; throw new Error('certificate changed'); };
    const client = new RouterOSClient('127.0.0.1', port, 'admin', 'secret-password', 5_000, 5_000, true);
    await expect(client.connect()).rejects.toThrow('certificate changed');
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.concat(received).length).toBe(0);
  });

  it('sends the login once the verifier accepts the certificate', async () => {
    RouterOSClient.tlsVerifier = async () => {};
    const client = new RouterOSClient('127.0.0.1', port, 'admin', 'secret-password', 5_000, 500, true);
    // The fake device never answers, so the login times out; what matters is that it was sent.
    await client.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(Buffer.concat(received).toString('latin1')).toContain('/login');
    client.disconnect();
  });

  it('records the fingerprint of the certificate it saw', async () => {
    let seen = '';
    RouterOSClient.tlsVerifier = async (_h, _p, fp) => { seen = fp; throw new Error('stop'); };
    const client = new RouterOSClient('127.0.0.1', port, 'u', 'p', 5_000, 5_000, true);
    await client.connect().catch(() => {});
    const expected = new X509Certificate(pair!.cert).fingerprint256.replace(/:/g, '').toLowerCase();
    expect(seen).toBe(expected);
    expect(client.tlsFingerprint).toBe(expected);
  });
});
