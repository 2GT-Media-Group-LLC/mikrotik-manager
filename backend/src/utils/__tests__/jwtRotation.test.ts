import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// Outside review S8: a JWT_SECRET set after secrets.json leaked must retire the leaked one.
describe('JWT secret rotation via the environment', () => {
  const OLD_ENV = process.env;
  let tmpDir: string;
  const file = () => path.join(tmpDir, 'secrets.json');
  const LEAKED = 'leaked-auto-generated-secret-'.padEnd(64, 'x');
  const NEW = 'operator-chosen-new-secret-'.padEnd(64, 'y');

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-jwtrot-'));
    fs.writeFileSync(file(), JSON.stringify({ jwtSecret: LEAKED, encryptionKey: 'k'.repeat(32) }));
    process.env = { ...OLD_ENV, SECRETS_DIR: tmpDir };
    delete process.env.ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = OLD_ENV;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = async () => {
    const secrets = await import('../secrets');
    secrets.initSecrets();
    return secrets;
  };

  it('keeps the old secret only until sessions signed with it run out', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-01T00:00:00Z') });
    process.env.JWT_SECRET = NEW;
    const secrets = await load();
    expect(secrets.jwtSigningSecret()).toBe(NEW);
    expect(secrets.jwtVerifierSecrets()).toEqual([NEW, LEAKED]);
    jest.setSystemTime(new Date('2026-10-02T00:00:01Z'));
    expect(secrets.jwtVerifierSecrets()).toEqual([NEW]);
  });

  it('takes the old secret out of the file, so unsetting JWT_SECRET cannot bring it back', async () => {
    process.env.JWT_SECRET = NEW;
    await load();
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(saved.jwtSecret).toBeUndefined();
    expect(saved.retiringJwtSecrets.map((r: { secret: string }) => r.secret)).toEqual([LEAKED]);
    expect(JSON.stringify(saved)).not.toContain(NEW); // the env secret is never written

    jest.resetModules();
    delete process.env.JWT_SECRET;
    const after = await load();
    expect(after.jwtSigningSecret()).not.toBe(LEAKED);
  });

  it('keeps the deadline from the first time the new secret was seen', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-01T00:00:00Z') });
    process.env.JWT_SECRET = NEW;
    await load();
    jest.setSystemTime(new Date('2026-10-01T20:00:00Z'));
    jest.resetModules();
    const restarted = await load();
    jest.setSystemTime(new Date('2026-10-02T00:00:01Z'));
    expect(restarted.jwtVerifierSecrets()).toEqual([NEW]);
  });
});
