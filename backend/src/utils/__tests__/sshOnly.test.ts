import { parseSshInfo, looksLikeRouterOs, classifyApiFailure, apiCheckIntervalMs, parseSshOnlyFlag, describeSshFailure, SSH_INFO_COMMAND } from '../sshOnly';

// Captured from 2GT-NW-MIKROTIK10G-TEST and the wAP ax (RouterOS 7.24.5) with SSH_INFO_COMMAND.
const CRS309 = `identity=2GT-NW-MIKROTIK10G-TEST
version=7.24.5 (stable)
board=CRS309-1G-8S+
arch=arm
serial=CB7A0B4C38C7
model=CRS309-1G-8S+
firmware=7.24.5`;

const WAPAX = 'identity= 2GT-NW-AP4\r\nversion=7.24.5 (stable)\r\nboard=wAP ax\r\narch=arm\r\nserial=HKM0B4F9FG0\r\nmodel=wAPG-5HaxD2HaxD\r\nfirmware=7.24.5\r\n';

describe('parseSshInfo', () => {
  it('reads a switch', () => {
    expect(parseSshInfo(CRS309)).toEqual({
      identity: '2GT-NW-MIKROTIK10G-TEST', rosVersion: '7.24.5', model: 'CRS309-1G-8S+',
      serial: 'CB7A0B4C38C7', firmware: '7.24.5', architecture: 'arm',
    });
  });

  it('keeps the identity as the router has it and prefers the routerboard model', () => {
    const i = parseSshInfo(WAPAX);
    expect(i.identity).toBe(' 2GT-NW-AP4');
    expect(i.model).toBe('wAPG-5HaxD2HaxD');
    expect(i.serial).toBe('HKM0B4F9FG0');
  });

  it('falls back to the board name on a CHR, which has no routerboard', () => {
    const i = parseSshInfo('identity=chr1\nversion=7.20 (stable)\nboard=CHR QEMU Standard PC\narch=x86_64\n');
    expect(i).toMatchObject({ model: 'CHR QEMU Standard PC', serial: null, firmware: null, rosVersion: '7.20' });
    expect(looksLikeRouterOs(i)).toBe(true);
  });

  it('takes an identity containing "="', () => {
    expect(parseSshInfo('identity=site=north\nversion=6.49.10 (long-term)').identity).toBe('site=north');
  });

  it('does not mistake another system for RouterOS', () => {
    expect(looksLikeRouterOs(parseSshInfo('bash: :put: command not found'))).toBe(false);
  });

  it('is one line, so it runs as a single SSH exec', () => {
    expect(SSH_INFO_COMMAND).not.toContain('\n');
  });
});

describe('classifyApiFailure', () => {
  it('tells a closed API from a refused login', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8729'), { code: 'ECONNREFUSED' });
    expect(classifyApiFailure(refused).kind).toBe('unreachable');
    expect(classifyApiFailure(new Error('Connection timeout')).kind).toBe('unreachable');
    expect(classifyApiFailure(new Error('invalid user name or password (6)')).kind).toBe('login');
    expect(classifyApiFailure(new Error('write EPROTO ... sslv3 alert handshake failure')).kind).toBe('tls');
  });

  it('retries a refused login rarely', () => {
    expect(apiCheckIntervalMs('login')).toBeGreaterThanOrEqual(15 * 60_000);
    expect(apiCheckIntervalMs('unreachable')).toBe(60_000);
  });
});

describe('parseSshOnlyFlag', () => {
  it('reads form and CSV values', () => {
    for (const v of [true, 'yes', 'Y', 'true', '1', 'x', 'ssh', 'ssh-only', ' SSH only ']) expect(parseSshOnlyFlag(v)).toBe(true);
    for (const v of [false, '', 'no', '0', 'false', undefined, null, 'api']) expect(parseSshOnlyFlag(v)).toBe(false);
  });
});

describe('describeSshFailure', () => {
  it('words the common SSH failures', () => {
    expect(describeSshFailure(new Error('All configured authentication methods failed'), 22)).toMatch(/login was refused/);
    expect(describeSshFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 2222)).toMatch(/port 2222/);
    expect(describeSshFailure(new Error('Timed out while waiting for handshake'), 22)).toMatch(/Timed out/);
    expect(describeSshFailure(new Error('some internal ssh2 detail'), 22)).toBe('Could not log in over SSH. Check the address, SSH port and login.');
  });
});
