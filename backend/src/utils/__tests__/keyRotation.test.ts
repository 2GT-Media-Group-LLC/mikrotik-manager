import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Key rotation and lost-key protection (outside review P2-29). Each test loads
 * the modules fresh against a temporary secrets directory.
 */
describe('encryption key rotation', () => {
  const OLD_ENV = process.env;
  let tmpDir: string;
  const secretsFile = () => path.join(tmpDir, 'secrets.json');
  const saved = () => JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as { encryptionKey?: string; prevEncryptionKeys?: string[] };

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-keyrot-'));
    process.env = { ...OLD_ENV, SECRETS_DIR: tmpDir };
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    delete process.env.JWT_SECRET;
  });
  afterEach(() => {
    process.env = OLD_ENV;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = async () => ({ secrets: await import('../secrets'), crypto: await import('../crypto') });

  it('saves a generated key only once startup confirms nothing needs another key', async () => {
    const { secrets } = await load();
    secrets.initSecrets();
    expect(fs.existsSync(secretsFile()) ? saved().encryptionKey : undefined).toBeUndefined();
    expect(secrets.confirmEncryptionKey(0)).toEqual({ saved: true, lost: false });
    expect(saved().encryptionKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not save a new key over data it cannot read, and refuses to encrypt with it', async () => {
    const { secrets, crypto } = await load();
    secrets.initSecrets();
    expect(secrets.confirmEncryptionKey(3)).toEqual({ saved: false, lost: true });
    expect(fs.existsSync(secretsFile()) ? saved().encryptionKey : undefined).toBeUndefined();
    expect(secrets.encryptionKeyMissing()).toBe(true);
    expect(() => crypto.encrypt('secret')).toThrow(/encryption key is missing/);
  });

  it('keeps the old key through a rotation, so older values still decrypt', async () => {
    const { secrets, crypto } = await load();
    secrets.initSecrets();
    secrets.confirmEncryptionKey(0);
    const oldKey = saved().encryptionKey!;
    const before = crypto.encrypt('router-password');

    const { keyId } = secrets.rotateEncryptionKey();
    expect(saved().encryptionKey).not.toBe(oldKey);
    expect(saved().prevEncryptionKeys).toContain(oldKey);
    expect(keyId).toMatch(/^[0-9a-f]{12}$/);

    expect(crypto.decrypt(before)).toBe('router-password');
    expect(crypto.ciphertextKeyState(before)).toBe('old');
    expect(crypto.ciphertextKeyState(crypto.encrypt('x'))).toBe('current');
  });

  it('survives a restart after rotating', async () => {
    let { secrets, crypto } = await load();
    secrets.initSecrets();
    secrets.confirmEncryptionKey(0);
    const before = crypto.encrypt('router-password');
    secrets.rotateEncryptionKey();

    jest.resetModules();
    ({ secrets, crypto } = await load());
    secrets.initSecrets();
    expect(crypto.decrypt(before)).toBe('router-password');
  });

  it('retires older keys', async () => {
    const { secrets, crypto } = await load();
    secrets.initSecrets();
    secrets.confirmEncryptionKey(0);
    const before = crypto.encrypt('router-password');
    secrets.rotateEncryptionKey();
    expect(secrets.retireOldEncryptionKeys()).toBe(1);
    expect(saved().prevEncryptionKeys).toEqual([]);
    expect(crypto.ciphertextKeyState(before)).toBe('none');
  });

  it('refuses to rotate a key that comes from .env', async () => {
    process.env.ENCRYPTION_KEY = 'an-operator-chosen-key-of-some-length';
    const { secrets } = await load();
    secrets.initSecrets();
    expect(() => secrets.rotateEncryptionKey()).toThrow(/ENCRYPTION_KEY_PREVIOUS/);
  });

  it('reads values under the key named in ENCRYPTION_KEY_PREVIOUS after .env changes', async () => {
    process.env.ENCRYPTION_KEY = 'first-operator-key-aaaaaaaaaaaaaa';
    let { secrets, crypto } = await load();
    secrets.initSecrets();
    const before = crypto.encrypt('router-password');

    jest.resetModules();
    process.env.ENCRYPTION_KEY = 'second-operator-key-bbbbbbbbbbbbb';
    process.env.ENCRYPTION_KEY_PREVIOUS = 'first-operator-key-aaaaaaaaaaaaaa';
    ({ secrets, crypto } = await load());
    secrets.initSecrets();
    expect(crypto.decrypt(before)).toBe('router-password');
    expect(crypto.ciphertextKeyState(before)).toBe('old');
  });
});
