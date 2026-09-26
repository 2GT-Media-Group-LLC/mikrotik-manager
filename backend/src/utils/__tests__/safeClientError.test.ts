import { safeConnectionError } from '../safeClientError';

// Silence the intentional console.warn (full detail is logged server-side by design).
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

function errWithCode(message: string, code?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  if (code) err.code = code;
  return err;
}

describe('safeConnectionError', () => {
  it('maps DNS failures to a resolution message', () => {
    expect(safeConnectionError('ctx', errWithCode('getaddrinfo ENOTFOUND foo', 'ENOTFOUND')))
      .toMatch(/hostname could not be resolved/i);
    expect(safeConnectionError('ctx', errWithCode('getaddrinfo EAI_AGAIN foo', 'EAI_AGAIN')))
      .toMatch(/hostname could not be resolved/i);
  });

  // Seen on real hardware: these arrive as plain messages from RouterOSClient.
  it('says when the login itself was refused', () => {
    expect(safeConnectionError('ctx', new Error('invalid user name or password (6)')))
      .toBe('Login failed: the username or password is wrong.');
  });

  it('says when the port answered but not as the API (e.g. Winbox 8291)', () => {
    expect(safeConnectionError('ctx', new Error('Read timeout waiting for API response')))
      .toMatch(/did not answer as the RouterOS API/);
  });

  it('maps ECONNREFUSED to a service-not-enabled message', () => {
    expect(safeConnectionError('ctx', errWithCode('connect ECONNREFUSED 1.2.3.4:8728', 'ECONNREFUSED')))
      .toMatch(/connection refused/i);
  });

  it('maps unreachable-host codes to a routing/firewall message', () => {
    expect(safeConnectionError('ctx', errWithCode('connect ETIMEDOUT 1.2.3.4:8728', 'ETIMEDOUT')))
      .toMatch(/unreachable/i);
    expect(safeConnectionError('ctx', errWithCode('connect EHOSTUNREACH 1.2.3.4:8728', 'EHOSTUNREACH')))
      .toMatch(/unreachable/i);
  });

  it('maps ECONNRESET to a reset message', () => {
    expect(safeConnectionError('ctx', errWithCode('read ECONNRESET', 'ECONNRESET')))
      .toMatch(/reset/i);
  });

  it('maps the client\'s own connect-timeout (no .code) by message', () => {
    expect(safeConnectionError('ctx', new Error('Connection timeout to 1.2.3.4:8728')))
      .toMatch(/timed out/i);
  });

  it('maps a socket closed mid-login to a hint about the RouterOS service allowlist', () => {
    // The exact failure reported when a device is reachable over a VPN but not
    // over its public IP: RouterOS accepts the TCP connection, then drops it
    // during login because the source isn't in IP > Services > api's "Available From".
    const msg = safeConnectionError('ctx', new Error('Connection closed'));
    expect(msg).toMatch(/closed the connection during login/i);
    expect(msg).toMatch(/available from/i);
  });

  it('falls back to the generic message for anything else', () => {
    expect(safeConnectionError('ctx', new Error('something unexpected')))
      .toMatch(/cannot connect to device/i);
  });
});
