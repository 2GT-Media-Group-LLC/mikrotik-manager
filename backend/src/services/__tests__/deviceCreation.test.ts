jest.mock('../../config/database');
jest.mock('../mikrotik/RouterOSClient');
jest.mock('../../utils/crypto', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s,
}));

import { computeNameLocked, createDeviceFromBody, loadCredentialPreset } from '../deviceCreation';
import { query, queryOne } from '../../config/database';
import { RouterOSClient } from '../mikrotik/RouterOSClient';

/**
 * Whether a newly-created device's name should stop following the router's
 * own /system/identity (DeviceCollector.collectSystemInfo). See the PR
 * discussion this came out of: a typed "+ Add Device" name was silently
 * reverted to RouterOS's factory identity ("MikroTik") on the first poll.
 */
describe('computeNameLocked', () => {
  it('stays unlocked when the name is just the address placeholder', () => {
    // CSV import / Try All default an unnamed device's name to its address —
    // that's "nothing was given", not a deliberate choice, regardless of what
    // the router's identity turns out to be.
    expect(computeNameLocked('192.168.88.1', '192.168.88.1', 'Core-Switch')).toBe(false);
    expect(computeNameLocked('192.168.88.1', '192.168.88.1', null)).toBe(false);
  });

  it('stays unlocked for a placeholder hostname regardless of case', () => {
    // CSV import / Try All name an unnamed row after the address exactly as
    // typed ("Router.Example.com"), but normalizeDeviceAddress lowercases a
    // hostname before it reaches here ("router.example.com") — that must
    // still be recognised as the placeholder, not a deliberately typed name.
    expect(computeNameLocked('Router.Example.com', 'router.example.com', 'Core-Switch')).toBe(false);
  });

  it('stays unlocked when the router\'s identity could not be read', () => {
    // Fail open: without something to compare against, assume nothing
    // deliberate happened rather than guessing.
    expect(computeNameLocked('aaa', '192.168.88.1', null)).toBe(false);
  });

  it('stays unlocked when the typed name already matches the router\'s identity', () => {
    // Nothing to lock — following the identity going forward changes nothing.
    expect(computeNameLocked('Core-Switch', '192.168.88.1', 'Core-Switch')).toBe(false);
  });

  it('locks when the typed name differs from both the address and the identity', () => {
    expect(computeNameLocked('aaa', '192.168.88.1', 'MikroTik')).toBe(true);
    expect(computeNameLocked('aaa', '192.168.88.1', 'Core-Switch')).toBe(true);
  });
});

/**
 * End-to-end through createDeviceFromBody (the actual POST /api/devices
 * path), not just the pure computeNameLocked() function — to catch a bug in
 * how the connection test's identity read actually gets threaded into the
 * INSERT, which the unit tests above can't see.
 */
describe('createDeviceFromBody (name_locked wiring)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockRouterOSClient(responses: Record<string, Record<string, string>[]>) {
    (RouterOSClient as unknown as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      execute: jest.fn((path: string) => Promise.resolve(responses[path] ?? [])),
    }));
  }

  /** The INSERT's positional params: (name, name_locked, ip_address, ...). */
  function insertedNameLocked(): unknown {
    const insertCall = (query as jest.Mock).mock.calls.find(
      ([sql]: [string]) => /INSERT INTO devices/.test(sql)
    );
    if (!insertCall) throw new Error('No INSERT INTO devices call was made');
    return insertCall[1][1];
  }

  it('locks the name when it differs from the identity the device reports at creation', async () => {
    mockRouterOSClient({
      '/system/routerboard/print': [{ 'serial-number': 'ABC123' }],
      '/system/identity/print': [{ name: 'MikroTik' }],
    });
    (queryOne as jest.Mock).mockResolvedValueOnce(null); // no existing device with this serial
    (query as jest.Mock).mockResolvedValue([{ id: 42 }]);
    (queryOne as jest.Mock).mockResolvedValueOnce({ id: 42, name: 'test' }); // post-insert reload

    const result = await createDeviceFromBody(
      { name: 'test', ip_address: '192.168.88.1', api_username: 'admin', api_password: 'secret' },
      null
    );

    expect(result.ok).toBe(true);
    expect(insertedNameLocked()).toBe(true);
  });

  it('leaves the name unlocked when it matches the identity the device reports', async () => {
    mockRouterOSClient({
      '/system/routerboard/print': [{ 'serial-number': 'ABC123' }],
      '/system/identity/print': [{ name: 'Core-Switch' }],
    });
    (queryOne as jest.Mock).mockResolvedValueOnce(null);
    (query as jest.Mock).mockResolvedValue([{ id: 43 }]);
    (queryOne as jest.Mock).mockResolvedValueOnce({ id: 43, name: 'Core-Switch' });

    const result = await createDeviceFromBody(
      { name: 'Core-Switch', ip_address: '192.168.88.1', api_username: 'admin', api_password: 'secret' },
      null
    );

    expect(result.ok).toBe(true);
    expect(insertedNameLocked()).toBe(false);
  });

  it('leaves the name unlocked when /system/identity/print could not be read', async () => {
    // e.g. the command errors out on this device/RouterOS version — the
    // connection test itself still succeeds via routerboard/print.
    mockRouterOSClient({
      '/system/routerboard/print': [{ 'serial-number': 'ABC123' }],
      // no '/system/identity/print' entry -> execute() resolves [] for it
    });
    (queryOne as jest.Mock).mockResolvedValueOnce(null);
    (query as jest.Mock).mockResolvedValue([{ id: 44 }]);
    (queryOne as jest.Mock).mockResolvedValueOnce({ id: 44, name: 'test' });

    const result = await createDeviceFromBody(
      { name: 'test', ip_address: '192.168.88.1', api_username: 'admin', api_password: 'secret' },
      null
    );

    expect(result.ok).toBe(true);
    expect(insertedNameLocked()).toBe(false);
  });
});

/** api-ssl on a port other than 8729 (#257). */
describe('createDeviceFromBody (API-SSL on any port)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RouterOSClient as unknown as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      execute: jest.fn().mockResolvedValue([]),
    }));
    (queryOne as jest.Mock).mockResolvedValueOnce(null);
    (query as jest.Mock).mockResolvedValue([{ id: 50 }]);
    (queryOne as jest.Mock).mockResolvedValueOnce({ id: 50, name: 'nat' });
  });
  // The refused-port case returns before reading these; don't leak them onward.
  afterEach(() => { (queryOne as jest.Mock).mockReset(); (query as jest.Mock).mockReset(); });

  const base = { name: 'nat', ip_address: '203.0.113.5', api_username: 'admin', api_password: 'secret' };
  /** RouterOSClient(host, port, user, pass, connectMs, readMs, useTls). */
  const ctorArgs = () => (RouterOSClient as unknown as jest.Mock).mock.calls[0];
  const insertParams = () => (query as jest.Mock).mock.calls.find(([sql]: [string]) => /INSERT INTO devices/.test(sql))![1];

  it('connects with TLS on a custom port when asked, and stores the choice', async () => {
    const result = await createDeviceFromBody({ ...base, api_port: '18729', api_tls: true }, null);
    expect(result.ok).toBe(true);
    expect(ctorArgs()[1]).toBe(18729);
    expect(ctorArgs()[6]).toBe(true);
    expect(insertParams()[insertParams().length - 1]).toBe(true);
    expect((result as unknown as { body: { connection: { api_ssl: boolean } } }).body.connection.api_ssl).toBe(true);
  });

  it('keeps the old rule without a choice: plain on a custom port, nothing stored', async () => {
    await createDeviceFromBody({ ...base, api_port: 18728 }, null);
    expect(ctorArgs()[6]).toBe(false);
    expect(insertParams()[insertParams().length - 1]).toBeNull();
  });

  it('refuses a port out of range before connecting', async () => {
    for (const api_port of ['-1', '70000', '0']) {
      const result = await createDeviceFromBody({ ...base, api_port }, null);
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
    expect(RouterOSClient).not.toHaveBeenCalled();
  });
});

/**
 * Admin-only credential presets. The bulk-add worker used to pass no role, and
 * the check only stopped callers whose role was exactly "operator", so a bulk
 * add could use a restricted preset (and, since adding a device connects to
 * the address given, send its credentials to any host).
 */
describe('loadCredentialPreset (admin-only presets)', () => {
  const restricted = {
    id: 5, api_username: 'admin', api_password_encrypted: 'pw', api_port: 8728,
    ssh_username: null, ssh_password_encrypted: null, ssh_port: null,
    allow_operator_use: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (queryOne as jest.Mock).mockResolvedValue(restricted);
  });

  it('lets an admin use a restricted preset', async () => {
    await expect(loadCredentialPreset(5, { requestingUserRole: 'admin' })).resolves.toMatchObject({ api_username: 'admin' });
  });

  it('refuses an operator', async () => {
    await expect(loadCredentialPreset(5, { requestingUserRole: 'operator' })).rejects.toThrow(/restricted to administrators/);
  });

  it('refuses a caller that passed no role at all', async () => {
    await expect(loadCredentialPreset(5, {})).rejects.toThrow(/restricted to administrators/);
    await expect(loadCredentialPreset(5)).rejects.toThrow(/restricted to administrators/);
  });

  it('still lets anyone use a preset open to operators', async () => {
    (queryOne as jest.Mock).mockResolvedValue({ ...restricted, allow_operator_use: true });
    await expect(loadCredentialPreset(5, {})).resolves.toMatchObject({ api_username: 'admin' });
  });
});
