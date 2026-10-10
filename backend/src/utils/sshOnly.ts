/**
 * Devices added over SSH only (#174): the RouterOS API isn't enabled on them
 * yet. The manager reaches them over SSH (bulk commands, templates, the
 * terminal, backups, config history) and keeps trying the API, and once it
 * answers the device becomes an ordinary one.
 *
 * The pure half: the command that reads a device's basics over SSH, reading
 * its output, and describing why the API isn't usable yet.
 */

/**
 * One SSH command that prints the basics as key=value lines. The routerboard
 * lines are wrapped in on-error, so a CHR or x86 install (no routerboard)
 * still prints the rest. Works on RouterOS 6 and 7.
 */
export const SSH_INFO_COMMAND = [
  ':put ("identity=" . [/system identity get name])',
  ':put ("version=" . [/system resource get version])',
  ':put ("board=" . [/system resource get board-name])',
  ':put ("arch=" . [/system resource get architecture-name])',
  ':do {:put ("serial=" . [/system routerboard get serial-number])} on-error={}',
  ':do {:put ("model=" . [/system routerboard get model])} on-error={}',
  ':do {:put ("firmware=" . [/system routerboard get current-firmware])} on-error={}',
].join('; ');

export interface SshInfo {
  /** /system identity, exactly as the router has it. */
  identity: string | null;
  /** RouterOS version without the channel: "7.24.5", not "7.24.5 (stable)". */
  rosVersion: string | null;
  /** The routerboard model, else the board name (as the API poll stores it). */
  model: string | null;
  serial: string | null;
  firmware: string | null;
  architecture: string | null;
}

/** Read the output of SSH_INFO_COMMAND. Unknown lines are ignored. */
export function parseSshInfo(output: string): SshInfo {
  const kv = new Map<string, string>();
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[a-z]+$/.test(key) || kv.has(key)) continue;
    kv.set(key, line.slice(eq + 1));
  }
  const val = (k: string): string | null => {
    const v = kv.get(k);
    return v !== undefined && v.trim() !== '' ? v : null;
  };
  const version = val('version');
  return {
    identity: val('identity'),
    rosVersion: version ? version.trim().split(/\s+/)[0] : null,
    model: val('model')?.trim() ?? val('board')?.trim() ?? null,
    serial: val('serial')?.trim() ?? null,
    firmware: val('firmware')?.trim() ?? null,
    architecture: val('arch')?.trim() ?? null,
  };
}

/** Did the output come from RouterOS at all? A login to something else prints none of these. */
export function looksLikeRouterOs(info: SshInfo): boolean {
  return !!(info.rosVersion && /^\d+\.\d+/.test(info.rosVersion));
}

export type ApiFailureKind = 'unreachable' | 'login' | 'tls' | 'other';

/** Why the API isn't usable yet, in words, and how soon it is worth trying again. */
export function classifyApiFailure(err: unknown): { kind: ApiFailureKind; message: string } {
  const msg = (err as Error)?.message ?? String(err);
  const code = (err as NodeJS.ErrnoException)?.code;
  if (/invalid user name or password|cannot log in|login failure|not allowed/i.test(msg)) {
    return {
      kind: 'login',
      message: 'The API answered but refused the login. Check the API username and password, and that the user\'s group has the "api" policy.',
    };
  }
  if (/handshake failure|alert number 40|no shared cipher|certificate|self.signed|tls/i.test(msg)) {
    return { kind: 'tls', message: 'api-ssl answered but the TLS connection failed (it may have no certificate).' };
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|refused/i.test(msg)) {
    return { kind: 'unreachable', message: 'The API service is turned off (the connection was refused).' };
  }
  if (/timeout|timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg) || code === 'ETIMEDOUT') {
    return { kind: 'unreachable', message: 'Nothing answered on the API ports; the service is off or a firewall blocks it.' };
  }
  return { kind: 'other', message: msg.split('\n')[0].slice(0, 200) };
}

/**
 * How long to wait before the next automatic API check. A refused login is
 * retried rarely, so a wrong password doesn't fill the router's log with
 * failed logins every minute.
 */
export function apiCheckIntervalMs(kind: ApiFailureKind | null): number {
  if (kind === 'login') return 15 * 60_000;
  if (kind === 'tls' || kind === 'other') return 5 * 60_000;
  return 60_000;
}

/** An ssh_only value from a form or a CSV cell: yes/true/1/y/x. */
export function parseSshOnlyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return /^(yes|y|true|1|x|ssh|ssh[-_ ]?only)$/i.test(String(value).trim());
}

/**
 * Raised instead of trying the API on a device added over SSH only, so every
 * API feature says what is going on rather than "connection refused".
 */
export class ApiNotEnabledError extends Error {
  readonly code = 'api_not_enabled';
  constructor(deviceName: string) {
    super(
      `${deviceName.trim()} was added over SSH only, so this needs its RouterOS API, which isn't enabled yet. ` +
      'Turn on api-ssl (or api) on the device, for example with a bulk command, then use Check API on its page.'
    );
    this.name = 'ApiNotEnabledError';
  }
}

/** Why an SSH login failed, in words someone can act on, without echoing raw library errors. */
export function describeSshFailure(err: unknown, port: number): string {
  const msg = (err as Error)?.message ?? String(err);
  const code = (err as NodeJS.ErrnoException)?.code;
  if (/all configured authentication methods failed|authentication failed/i.test(msg)) {
    return 'The SSH login was refused: the username or password is wrong, or the user has no "ssh" policy.';
  }
  if (code === 'ECONNREFUSED') return `Nothing accepted SSH on port ${port}; the ssh service may be off or on another port.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The hostname could not be resolved. Check the address for typos.';
  if (/timed out|timeout|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg) || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') {
    return `Timed out reaching SSH on port ${port}. Check the address and firewall rules.`;
  }
  // Our own messages (host key changed, not RouterOS) are already worded for people.
  if (/host key|did not answer like RouterOS/i.test(msg)) return msg;
  return 'Could not log in over SSH. Check the address, SSH port and login.';
}
