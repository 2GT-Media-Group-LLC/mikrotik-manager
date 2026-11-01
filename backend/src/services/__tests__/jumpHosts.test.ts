import net, { AddressInfo } from 'net';
import tls from 'tls';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client as SSHClient, Server as SSHServer, utils as sshUtils } from 'ssh2';
import { query, queryOne } from '../../config/database';
import { RouterOSClient } from '../mikrotik/RouterOSClient';
import { connectPreferringSsl, API_PORT, API_SSL_PORT } from '../mikrotik/apiConnect';
import https from 'https';
import {
  openForwardedChannel, sshRoute, routeOf, dropJumpHost, trustNewJumpHostKey, testJumpHost, jumpHostStatus,
  closeIdleJumpHosts, keepalive, parseHostKeyFingerprint, backoffMs, JumpHostError, type JumpHostRow,
} from '../jumpHosts';
import { sshHostKeyFingerprint } from '../identityPins';
import { httpsAnswers } from '../wwwSsl';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../utils/crypto', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));
jest.mock('../AlertService', () => ({ alertService: { dispatch: jest.fn() } }));
// wwwSsl's own device work isn't under test here, only its HTTPS check.
jest.mock('../mikrotik/DeviceCollector', () => ({ DeviceCollector: jest.fn() }));
jest.mock('../apiSsl', () => ({ ensureCertificate: jest.fn(), certByName: jest.fn(), usable: jest.fn() }));

/**
 * Devices behind an SSH jump host. A real SSH server (ssh2's) stands in for
 * the jump router and opens the forwarded connections, so these exercise the
 * actual channels: the API over one, TLS over one, SSH over one.
 */

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

const JUMP_KEY = sshUtils.generateKeyPairSync('ed25519').private;
const OTHER_KEY = sshUtils.generateKeyPairSync('ed25519').private;
const fingerprintOf = (privateKey: string): string => {
  const parsed = sshUtils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return sshHostKeyFingerprint(key.getPublicSSH());
};

// ─── A fake database: just the jump_hosts rows ──────────────────────────────

const rows = new Map<number, JumpHostRow>();
const presets = new Map<number, { api_username: string; api_password_encrypted: string; ssh_username: string | null; ssh_password_encrypted: string | null }>();

function addJumpHost(id: number, port: number, over: Partial<JumpHostRow> = {}): JumpHostRow {
  const row: JumpHostRow = {
    id, name: `jump-${id}`, site_id: null, host: '127.0.0.1', port,
    username: 'jump', password_encrypted: 'jump-pass', private_key_encrypted: null, passphrase_encrypted: null,
    credential_preset_id: null, host_key_fingerprint: null, seen_host_key_fingerprint: null, ...over,
  };
  rows.set(id, row);
  return row;
}

beforeEach(() => {
  mockQueryOne.mockImplementation((async (sql: string, params: unknown[]) => {
    if (/FROM jump_hosts WHERE id = \$1/.test(sql)) {
      const r = rows.get(params[0] as number);
      return r ? { ...r } : null;
    }
    if (/FROM credential_presets WHERE id = \$1/.test(sql)) {
      const p = presets.get(params[0] as number);
      return p ? { ...p } : null;
    }
    return null;
  }) as never);
  mockQuery.mockImplementation((async (sql: string, params: unknown[]) => {
    const r = rows.get(params?.[0] as number);
    if (r && /SET host_key_fingerprint = \$2 WHERE id = \$1 AND host_key_fingerprint IS NULL/.test(sql)) {
      if (r.host_key_fingerprint) return [];
      r.host_key_fingerprint = params[1] as string;
      return [{ id: r.id }];
    }
    if (r && /SET seen_host_key_fingerprint = \$2/.test(sql)) {
      r.seen_host_key_fingerprint = params[1] as string;
      return [];
    }
    if (r && /SET host_key_fingerprint = seen_host_key_fingerprint/.test(sql)) {
      if (!r.seen_host_key_fingerprint) return [];
      r.host_key_fingerprint = r.seen_host_key_fingerprint;
      r.seen_host_key_fingerprint = null;
      return [{ id: r.id }];
    }
    return [];
  }) as never);
  RouterOSClient.channelOpener = openForwardedChannel;
});

afterEach(() => {
  for (const id of rows.keys()) dropJumpHost(id);
  rows.clear();
  presets.clear();
  RouterOSClient.channelOpener = null;
  RouterOSClient.tlsVerifier = null;
});

// ─── Test servers ───────────────────────────────────────────────────────────

interface JumpServer {
  port: number;
  connections: number;
  logins: number;
  /** Every login method a client tried, in order. */
  authMethods: string[];
  forwards: string[];
  /** Forwarded channels the manager has closed. */
  channelsClosed: number;
  close(): Promise<void>;
}

/**
 * The jump router. `forwarding: false` is RouterOS without forwarding-enabled;
 * `forwardDelayMs` is a router slow to reach the device, `loginDelayMs` one
 * slow to accept the login. `acceptsFirst` forwards as RouterOS does: it
 * confirms the channel before connecting onward, and closes it if that fails
 * (OpenSSH, the default here, refuses the channel instead). `ports` sends a
 * forward for one port to another, for the API's fixed ports.
 */
async function startJumpServer(
  opts: {
    forwarding?: boolean; hostKey?: string; forwardDelayMs?: number; loginDelayMs?: number; ignoresGlobalRequests?: boolean;
    acceptsFirst?: boolean; ports?: Record<number, number>;
  } = {},
): Promise<JumpServer> {
  const s: JumpServer = { port: 0, connections: 0, logins: 0, authMethods: [], forwards: [], channelsClosed: 0, close: async () => {} };
  // Closed with the server: the manager keeps its jump connection open.
  const open = new Set<{ end(): unknown } | net.Socket>();
  const server = new SSHServer({ hostKeys: [opts.hostKey ?? JUMP_KEY] }, (client) => {
    s.connections++;
    open.add(client);
    client.on('error', () => {});
    // RouterOS never answers a global request, keepalive@openssh.com included.
    if (opts.ignoresGlobalRequests) {
      (client as unknown as { _protocol: { requestFailure(): void } })._protocol.requestFailure = () => {};
    }
    client.on('authentication', (ctx) => {
      s.authMethods.push(ctx.method);
      if (ctx.method === 'password') s.logins++;
      if (ctx.method === 'password' && ctx.username === 'jump' && ctx.password === 'jump-pass') {
        setTimeout(() => ctx.accept(), opts.loginDelayMs ?? 0);
      } else ctx.reject(['password']);
    });
    client.on('ready', () => {
      if (opts.forwarding === false) return; // no 'tcpip' listener: "administratively prohibited"
      client.on('tcpip', (accept, reject, info) => {
        s.forwards.push(`${info.destIP}:${info.destPort}`);
        setTimeout(() => {
          const sock = net.connect(opts.ports?.[info.destPort] ?? info.destPort, info.destIP);
          open.add(sock);
          const early = opts.acceptsFirst ? accept() : null;
          sock.once('connect', () => {
            const ch = early ?? accept();
            sock.pipe(ch).pipe(sock);
            ch.on('error', () => sock.destroy());
            ch.on('close', () => { s.channelsClosed++; sock.destroy(); });
          });
          sock.once('error', () => (early ? early.close() : reject()));
        }, opts.forwardDelayMs ?? 0);
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  s.port = (server.address() as AddressInfo).port;
  s.close = () => new Promise<void>((r) => {
    server.close(() => r());
    for (const c of open) { if (c instanceof net.Socket) c.destroy(); else c.end(); }
  });
  return s;
}

/** A TCP relay in front of the jump router whose open connections can go silent, as over a dropped link. */
async function startLink(target: number): Promise<{ port: number; drop(): void; close(): Promise<void> }> {
  const pairs: net.Socket[][] = [];
  const server = net.createServer((inbound) => {
    const outbound = net.connect(target, '127.0.0.1');
    for (const sock of [inbound, outbound]) sock.on('error', () => {});
    inbound.pipe(outbound).pipe(inbound);
    pairs.push([inbound, outbound]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    drop: () => {
      for (const [inbound, outbound] of pairs) { inbound.unpipe(); outbound.unpipe(); inbound.pause(); outbound.pause(); }
    },
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      for (const pair of pairs) for (const sock of pair) sock.destroy();
    }),
  };
}

interface FakeDevice { port: number; connections: number; received: () => string; close(): Promise<void> }

/** A RouterOS API that accepts any login. */
async function startDevice(tlsPair?: { key: string; cert: string }): Promise<FakeDevice> {
  const chunks: Buffer[] = [];
  const d: FakeDevice = { port: 0, connections: 0, received: () => Buffer.concat(chunks).toString('latin1'), close: async () => {} };
  const open = new Set<net.Socket>();
  const onSocket = (sock: net.Socket) => {
    d.connections++;
    open.add(sock);
    sock.on('error', () => {});
    sock.on('data', (data: Buffer) => {
      chunks.push(data);
      if (data.includes('/login')) sock.write(Buffer.from([5, ...Buffer.from('!done'), 0]));
    });
  };
  const server = tlsPair ? tls.createServer(tlsPair, onSocket) : net.createServer(onSocket);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  d.port = (server.address() as AddressInfo).port;
  d.close = () => new Promise<void>((r) => {
    server.close(() => r());
    for (const sock of open) sock.destroy();
  });
  return d;
}

function makeCert(): { key: string; cert: string } | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'mtm-jump-'));
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

const api = (port: number, jumpHostId: number | null, useTls = false) =>
  new RouterOSClient('127.0.0.1', port, 'admin', 'secret', 3_000, 2_000, useTls, jumpHostId);

// ─── The route itself ───────────────────────────────────────────────────────

describe('routeOf', () => {
  it('reads null as direct and a number as that jump host', () => {
    expect(routeOf({ jump_host_id: null })).toBeNull();
    expect(routeOf({ jump_host_id: 4 })).toBe(4);
  });

  it('refuses to guess when the route was not loaded', () => {
    // A query that left out jump_host_id must not turn into a direct connection.
    expect(() => routeOf({})).toThrow(/route was not loaded/);
  });
});

describe('parseHostKeyFingerprint', () => {
  const hex = 'ab'.repeat(32);
  it('takes hex, with or without colons', () => {
    expect(parseHostKeyFingerprint(hex)).toBe(hex);
    expect(parseHostKeyFingerprint(hex.match(/../g)!.join(':').toUpperCase())).toBe(hex);
  });
  it('takes the SHA256:base64 form ssh-keygen prints', () => {
    const b64 = Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
    expect(parseHostKeyFingerprint(`SHA256:${b64}`)).toBe(hex);
  });
  it('refuses anything else', () => {
    expect(parseHostKeyFingerprint('MD5:aa:bb')).toBeNull();
    expect(parseHostKeyFingerprint('SHA256:short')).toBeNull();
  });
});

describe('backoffMs', () => {
  it('doubles from 5 seconds up to 5 minutes', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoffMs(20)).toBe(300_000);
  });
});

// ─── The API through a jump host ────────────────────────────────────────────

describe('RouterOS API through a jump host', () => {
  let jump: JumpServer;
  let device: FakeDevice;
  beforeEach(async () => { jump = await startJumpServer(); device = await startDevice(); });
  afterEach(async () => { await jump.close(); await device.close(); });

  it('logs in to the device over a channel the jump host opened', async () => {
    addJumpHost(1, jump.port);
    const client = api(device.port, 1);
    await client.connect();
    expect(client.isUsable()).toBe(true);
    expect(jump.forwards).toEqual([`127.0.0.1:${device.port}`]);
    expect(device.received()).toContain('=password=secret');
    // The device sees the jump host's port, which the manager can't know (Change Guard copes).
    expect(client.localPort).toBeNull();
    client.disconnect();
  });

  it('shares one SSH connection, and gives every client a new channel', async () => {
    addJumpHost(2, jump.port);
    const a = api(device.port, 2);
    const b = api(device.port, 2);
    await a.connect();
    await b.connect();
    // Change Guard's reachability check depends on this: a new client is a new TCP connection to the device.
    expect(jump.connections).toBe(1);
    expect(jump.forwards).toHaveLength(2);
    expect(device.connections).toBe(2);
    a.disconnect();
    b.disconnect();
  });

  // Guards jumpClient(): nothing may be awaited between looking for the open
  // connection and registering a new one.
  it('opens one SSH connection when many devices connect at once', async () => {
    addJumpHost(4, jump.port);
    const clients = Array.from({ length: 5 }, () => api(device.port, 4));
    await Promise.all(clients.map((c) => c.connect()));
    expect(jump.connections).toBe(1);
    expect(jump.forwards).toHaveLength(5);
    for (const c of clients) c.disconnect();
  });

  it('shows as connected only once logged in', async () => {
    const slow = await startJumpServer({ loginDelayMs: 400 });
    try {
      const row = addJumpHost(6, slow.port);
      expect(jumpHostStatus(6).state).toBe('idle');
      const client = api(device.port, 6);
      const connecting = client.connect();
      // Its host key is accepted (and pinned) before the login is.
      while (!row.host_key_fingerprint) await new Promise((r) => setTimeout(r, 10));
      expect(jumpHostStatus(6).state).toBe('idle');
      await connecting;
      expect(jumpHostStatus(6)).toMatchObject({ state: 'connected', channels: 1 });
      client.disconnect();
    } finally {
      await slow.close();
    }
  });

  it("logs in with its password alone, without the 'none' attempt RouterOS logs as a failed login", async () => {
    addJumpHost(25, jump.port);
    const c = api(device.port, 25);
    await c.connect();
    c.disconnect();
    expect(jump.authMethods).toEqual(['password']);
  });

  it('keeps a working connection when tested', async () => {
    addJumpHost(5, jump.port);
    const client = api(device.port, 5);
    await client.connect();
    expect((await testJumpHost(5)).ok).toBe(true);
    expect(jump.connections).toBe(1);
    expect(client.isUsable()).toBe(true);
    client.disconnect();
  });

  it('pins the jump host key the first time and accepts it after', async () => {
    const row = addJumpHost(3, jump.port);
    await api(device.port, 3).connect();
    expect(row.host_key_fingerprint).toBe(fingerprintOf(JUMP_KEY));
    dropJumpHost(3);
    const again = api(device.port, 3);
    await again.connect();
    expect(jump.connections).toBe(2);
    again.disconnect();
  });
});

describe('never falling back to a direct connection', () => {
  it('fails with the jump host as the reason when it is down, and never contacts the device', async () => {
    const device = await startDevice();
    // A port with nothing listening.
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    try {
      addJumpHost(10, deadPort, { name: 'core-rtr' });
      const err = await api(device.port, 10).connect().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JumpHostError);
      expect((err as Error).message).toMatch(/Jump host "core-rtr" \(127\.0\.0\.1:\d+\) is unreachable/);
      expect(device.connections).toBe(0);
    } finally {
      await device.close();
    }
  });

  it('refuses outright when jump host connections are not available in the process', async () => {
    RouterOSClient.channelOpener = null;
    const device = await startDevice();
    try {
      await expect(api(device.port, 11).connect()).rejects.toThrow(/reached through a jump host/);
      expect(device.connections).toBe(0);
    } finally {
      await device.close();
    }
  });

  it('backs off: within the backoff, devices behind a failed jump host fail at once without trying again', async () => {
    const jump = await startJumpServer();
    try {
      addJumpHost(12, jump.port, { password_encrypted: 'wrong' });
      await expect(openForwardedChannel(12, '127.0.0.1', 1)).rejects.toThrow(/refused the login/);
      await expect(openForwardedChannel(12, '127.0.0.1', 1)).rejects.toThrow(/next attempt in \d+s/);
      // Several at once within the backoff: still no new attempt.
      const many = await Promise.allSettled([1, 2, 3].map(() => openForwardedChannel(12, '127.0.0.1', 1)));
      expect(many.every((r) => r.status === 'rejected')).toBe(true);
      expect(jump.connections).toBe(1);
      // Changing the jump host (here: its password) is a new attempt straight away.
      rows.get(12)!.password_encrypted = 'jump-pass';
      const ch = await openForwardedChannel(12, '127.0.0.1', jump.port);
      ch.destroy();
      expect(jump.connections).toBe(2);
    } finally {
      await jump.close();
    }
  });
});

describe('a jump host slow to reach the device', () => {
  it('gives up after its time, and closes the channel if it opens later', async () => {
    const jump = await startJumpServer({ forwardDelayMs: 400 });
    const device = await startDevice();
    try {
      addJumpHost(15, jump.port);
      await expect(openForwardedChannel(15, '127.0.0.1', device.port, 150))
        .rejects.toThrow(/could not connect to 127\.0\.0\.1:\d+: no answer within 1s/);
      // Opened late on the router: closed by the manager, not left holding a connection to the device.
      await new Promise((r) => setTimeout(r, 900));
      expect(device.connections).toBe(1);
      expect(jump.channelsClosed).toBe(1);
      expect(jumpHostStatus(15)).toMatchObject({ state: 'connected', channels: 0 });
    } finally {
      await jump.close();
      await device.close();
    }
  });
});

/** Wait, up to a point, for `done` to hold. */
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
}

describe('counting channels', () => {
  it('stops counting one a client gave up on, though it opened later and nothing read it', async () => {
    const jump = await startJumpServer({ forwardDelayMs: 400 });
    const device = await startDevice();
    try {
      addJumpHost(21, jump.port);
      const c = new RouterOSClient('127.0.0.1', device.port, 'admin', 'secret', 150, 2_000, false, 21);
      await expect(c.connect()).rejects.toThrow(/through its jump host/);
      await until(() => jump.channelsClosed === 1);
      await until(() => jumpHostStatus(21).channels === 0, 300);
      expect(jump.channelsClosed).toBe(1);
      expect(jumpHostStatus(21)).toMatchObject({ state: 'connected', channels: 0 });
    } finally {
      await jump.close();
      await device.close();
    }
  });
});

describe('noticing a jump host has gone', () => {
  const saved = { ...keepalive };
  beforeEach(() => { keepalive.intervalMs = 100; keepalive.misses = 3; });
  afterEach(() => { Object.assign(keepalive, saved); });

  it('keeps a working connection to a jump host that never answers keepalives, as RouterOS does', async () => {
    const jump = await startJumpServer({ ignoresGlobalRequests: true });
    const device = await startDevice();
    try {
      addJumpHost(23, jump.port);
      (await openForwardedChannel(23, '127.0.0.1', device.port)).destroy();
      await new Promise((r) => setTimeout(r, keepalive.intervalMs * (keepalive.misses + 4)));
      expect(jumpHostStatus(23).state).toBe('connected');
      (await openForwardedChannel(23, '127.0.0.1', device.port)).destroy();
      expect(jump.connections).toBe(1);
    } finally {
      await jump.close();
      await device.close();
    }
  });

  it('closes the connection once nothing at all is heard from it', async () => {
    const jump = await startJumpServer({ ignoresGlobalRequests: true });
    const link = await startLink(jump.port);
    try {
      addJumpHost(24, link.port);
      (await openForwardedChannel(24, '127.0.0.1', jump.port)).destroy();
      link.drop();
      await until(() => jumpHostStatus(24).state !== 'connected', keepalive.intervalMs * (keepalive.misses + 4));
      expect(jumpHostStatus(24).state).toBe('idle');
    } finally {
      await link.close();
      await jump.close();
    }
  });
});

describe('the idle sweep', () => {
  const IDLE_MS = 15 * 60_000;

  it('closes a connection nothing uses, but not one a device is opening a channel on', async () => {
    const jump = await startJumpServer({ forwardDelayMs: 300 });
    const device = await startDevice();
    try {
      addJumpHost(19, jump.port);
      (await openForwardedChannel(19, '127.0.0.1', device.port)).destroy();
      await until(() => jumpHostStatus(19).channels === 0);
      const idleSince = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      // A device asks for a channel just as the connection's idle time runs out.
      const second = openForwardedChannel(19, '127.0.0.1', device.port);
      await until(() => jump.forwards.length === 2);
      closeIdleJumpHosts(idleSince + IDLE_MS + 10);
      (await second).destroy();
      expect(jump.connections).toBe(1);
      // Nothing open and nothing used since: closed.
      await until(() => jumpHostStatus(19).channels === 0);
      closeIdleJumpHosts(Date.now() + IDLE_MS + 10);
      expect(jumpHostStatus(19).state).toBe('idle');
    } finally {
      await jump.close();
      await device.close();
    }
  });
});

describe('closing a connection on purpose', () => {
  it('is not counted against the jump host: changed while connecting, it is tried again at once', async () => {
    const jump = await startJumpServer({ loginDelayMs: 300 });
    try {
      const row = addJumpHost(17, jump.port);
      const first = openForwardedChannel(17, '127.0.0.1', jump.port);
      while (!row.host_key_fingerprint) await new Promise((r) => setTimeout(r, 10));
      dropJumpHost(17); // as an edit of its login does
      await expect(first).rejects.toThrow(/was changed or removed while connecting/);
      const ch = await openForwardedChannel(17, '127.0.0.1', jump.port);
      ch.destroy();
      expect(jump.connections).toBe(2);
    } finally {
      await jump.close();
    }
  });
});

describe('a jump host logging in with a credential preset', () => {
  it("tries again at once when the preset's login changes", async () => {
    const jump = await startJumpServer();
    try {
      presets.set(1, { api_username: 'admin', api_password_encrypted: 'jump-pass', ssh_username: 'wrong', ssh_password_encrypted: null });
      addJumpHost(16, jump.port, { username: null, password_encrypted: null, credential_preset_id: 1 });
      await expect(openForwardedChannel(16, '127.0.0.1', 1)).rejects.toThrow(/refused the login/);
      await expect(openForwardedChannel(16, '127.0.0.1', 1)).rejects.toThrow(/next attempt in/);
      presets.get(1)!.ssh_username = 'jump';
      const ch = await openForwardedChannel(16, '127.0.0.1', jump.port);
      ch.destroy();
      expect(jump.connections).toBe(2);
    } finally {
      await jump.close();
    }
  });
});

describe('the jump host refusing', () => {
  it('says how to allow forwarding on the router when it is off', async () => {
    const jump = await startJumpServer({ forwarding: false });
    try {
      addJumpHost(20, jump.port);
      await expect(openForwardedChannel(20, '127.0.0.1', 8728))
        .rejects.toThrow('/ip ssh set forwarding-enabled=local');
    } finally {
      await jump.close();
    }
  });

  it('names the device, not the jump host, when the jump host is up but the device is not', async () => {
    const jump = await startJumpServer();
    try {
      addJumpHost(21, jump.port);
      const err = await openForwardedChannel(21, '127.0.0.1', 1).then(() => null, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(JumpHostError);
      expect(err!.message).toMatch(/could not connect to 127\.0\.0\.1:1: nothing accepted the connection/);
    } finally {
      await jump.close();
    }
  });

  it('stops before sending its login when the host key changed, records the new key, and connects once it is trusted', async () => {
    const jump = await startJumpServer({ hostKey: OTHER_KEY });
    try {
      const row = addJumpHost(22, jump.port, { host_key_fingerprint: fingerprintOf(JUMP_KEY) });
      await expect(openForwardedChannel(22, '127.0.0.1', jump.port)).rejects.toThrow(/presented SSH host key SHA256:/);
      expect(jump.logins).toBe(0);
      expect(row.seen_host_key_fingerprint).toBe(fingerprintOf(OTHER_KEY));

      expect(await trustNewJumpHostKey(22)).toBe(true);
      expect(row.host_key_fingerprint).toBe(fingerprintOf(OTHER_KEY));
      expect(await testJumpHost(22)).toEqual({ ok: true, fingerprint: fingerprintOf(OTHER_KEY) });
    } finally {
      await jump.close();
    }
  });
});

const tlsPair = makeCert();
(tlsPair ? describe : describe.skip)('API-SSL through a jump host', () => {
  it('runs TLS over the channel, and checks the certificate pin with the route', async () => {
    const jump = await startJumpServer();
    const device = await startDevice(tlsPair!);
    try {
      addJumpHost(30, jump.port);
      const seen: Array<[string, number, number | null]> = [];
      RouterOSClient.tlsVerifier = async (host, port, _fp, _raw, jumpHostId) => { seen.push([host, port, jumpHostId]); };
      const client = api(device.port, 30, true);
      await client.connect();
      expect(client.tlsFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // Pins are looked up by address, port and route: two devices behind
      // different jump hosts can share an address.
      expect(seen).toEqual([['127.0.0.1', device.port, 30]]);
      expect(jump.forwards).toEqual([`127.0.0.1:${device.port}`]);
      client.disconnect();
    } finally {
      await jump.close();
      await device.close();
    }
  });
});

// GHSA-63v6-w7qf-349f: API-SSL is tried first and the plain API only when
// API-SSL isn't there. Through a jump host that still holds, whichever way the
// jump host reports a port the device doesn't answer on.
describe('API-SSL first, then the plain API, through a jump host', () => {
  async function deadPort(): Promise<number> {
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    return port;
  }

  for (const [style, acceptsFirst] of [['a RouterOS', true], ['an OpenSSH', false]] as const) {
    it(`uses the plain API through ${style} jump host when the device has API-SSL off`, async () => {
      const device = await startDevice();
      const jump = await startJumpServer({ acceptsFirst, ports: { [API_SSL_PORT]: await deadPort(), [API_PORT]: device.port } });
      try {
        addJumpHost(acceptsFirst ? 40 : 41, jump.port);
        const r = await connectPreferringSsl('127.0.0.1', 'admin', 'secret', { jumpHostId: acceptsFirst ? 40 : 41, sslTimeoutMs: 3_000 });
        expect(r.port).toBe(API_PORT);
        expect(r.sslError).toBeTruthy();
        // One after the other, both through the jump host.
        expect(jump.forwards).toEqual([`127.0.0.1:${API_SSL_PORT}`, `127.0.0.1:${API_PORT}`]);
        expect(device.received()).toContain('=password=secret');
        r.client.disconnect();
      } finally {
        await jump.close();
        await device.close();
      }
    });
  }

  it('fails with the jump host as the reason when it is down, and contacts no device', async () => {
    const device = await startDevice();
    try {
      addJumpHost(42, await deadPort(), { name: 'edge-rtr' });
      const err = await connectPreferringSsl('127.0.0.1', 'admin', 'secret', { jumpHostId: 42 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JumpHostError);
      expect((err as Error).message).toMatch(/Jump host "edge-rtr" .* is unreachable/);
      expect(device.connections).toBe(0);
    } finally {
      await device.close();
    }
  });

  (tlsPair ? it : it.skip)('uses API-SSL through the jump host when the device has it, and never opens the plain API', async () => {
    const sslDevice = await startDevice(tlsPair!);
    const plainDevice = await startDevice();
    const jump = await startJumpServer({ acceptsFirst: true, ports: { [API_SSL_PORT]: sslDevice.port, [API_PORT]: plainDevice.port } });
    const verifier = RouterOSClient.tlsVerifier;
    RouterOSClient.tlsVerifier = async () => {};
    try {
      addJumpHost(43, jump.port);
      const r = await connectPreferringSsl('127.0.0.1', 'admin', 'secret', { jumpHostId: 43 });
      expect(r.port).toBe(API_SSL_PORT);
      expect(jump.forwards).toEqual([`127.0.0.1:${API_SSL_PORT}`]);
      expect(plainDevice.connections).toBe(0);
      r.client.disconnect();
    } finally {
      RouterOSClient.tlsVerifier = verifier;
      await jump.close();
      await sslDevice.close();
      await plainDevice.close();
    }
  });
});

(tlsPair ? describe : describe.skip)('WebFig HTTPS check through a jump host', () => {
  async function startHttps(): Promise<{ port: number; connections: number; close(): Promise<void> }> {
    const h = { port: 0, connections: 0, close: async () => {} };
    const server = https.createServer(tlsPair!, (_req, res) => { res.writeHead(302, { Location: '/webfig/' }); res.end(); });
    server.on('secureConnection', () => { h.connections++; });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    h.port = (server.address() as AddressInfo).port;
    h.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    return h;
  }

  it('asks through the jump host, and the channel is closed after', async () => {
    const jump = await startJumpServer();
    const web = await startHttps();
    try {
      addJumpHost(50, jump.port);
      expect(await httpsAnswers('127.0.0.1', web.port, 50)).toBeNull();
      expect(jump.forwards).toEqual([`127.0.0.1:${web.port}`]);
      expect(web.connections).toBe(1);
      await new Promise((r) => setTimeout(r, 200));
      expect(jumpHostStatus(50)).toMatchObject({ state: 'connected', channels: 0 });
    } finally {
      await jump.close();
      await web.close();
    }
  });

  it('reports the jump host, and never asks the address directly, when the jump host is down', async () => {
    const web = await startHttps();
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    try {
      addJumpHost(51, deadPort, { name: 'branch-gw' });
      expect(await httpsAnswers('127.0.0.1', web.port, 51)).toMatch(/Jump host "branch-gw" .* is unreachable/);
      expect(web.connections).toBe(0);
    } finally {
      await web.close();
    }
  });
});

describe('SSH to a device through a jump host', () => {
  it('runs the device SSH session over the forwarded channel', async () => {
    const jump = await startJumpServer();
    let deviceLogins = 0;
    const deviceSsh = new SSHServer({ hostKeys: [OTHER_KEY] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === 'dev-pass') { deviceLogins++; ctx.accept(); } else ctx.reject(['password']);
      });
    });
    await new Promise<void>((r) => deviceSsh.listen(0, '127.0.0.1', r));
    const devPort = (deviceSsh.address() as AddressInfo).port;
    try {
      addJumpHost(40, jump.port);
      const device = { ip_address: '127.0.0.1', jump_host_id: 40 };
      const route = await sshRoute(device, devPort);
      expect(route.sock).toBeDefined();
      await new Promise<void>((resolve, reject) => {
        const conn = new SSHClient();
        conn.on('ready', () => { conn.end(); resolve(); });
        conn.on('error', reject);
        conn.connect({ host: '127.0.0.1', port: devPort, username: 'admin', password: 'dev-pass', ...route });
      });
      expect(deviceLogins).toBe(1);
      expect(jump.forwards).toEqual([`127.0.0.1:${devPort}`]);
    } finally {
      await jump.close();
      await new Promise<void>((r) => deviceSsh.close(() => r()));
    }
  });

  it('adds nothing for a direct device', async () => {
    expect(await sshRoute({ ip_address: '10.0.0.1', jump_host_id: null }, 22)).toEqual({});
  });
});
