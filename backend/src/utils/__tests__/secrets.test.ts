import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as nodeCrypto from 'crypto';

// Reproduce ciphertext exactly as legacy code produced it under a given key.
function legacyEncrypt(plain: string, material: string): string {
  const key = material.length === 32
    ? Buffer.from(material, 'utf8')
    : nodeCrypto.createHash('sha256').update(material).digest();
  const iv = nodeCrypto.randomBytes(16);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

describe('self-healing secrets', () => {
  const OLD_ENV = process.env;
  let tmpDir: string;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-secrets-'));
    process.env = { ...OLD_ENV, SECRETS_DIR: tmpDir };
    delete process.env.JWT_SECRET;
    delete process.env.ENCRYPTION_KEY;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-generates and persists strong secrets when none are set', async () => {
    const secrets = await import('../secrets');
    const info = secrets.initSecrets();
    expect(info.jwtSource).toBe('generated');
    expect(info.encSource).toBe('generated');
    expect(info.persisted).toBe(true);
    expect(info.ephemeral).toBe(false);
    expect(secrets.jwtSigningSecret().length).toBeGreaterThanOrEqual(32);
    expect(fs.existsSync(path.join(tmpDir, 'secrets.json'))).toBe(true);
  });

  it('reuses the persisted secret across reloads (stable across restarts)', async () => {
    const first = await import('../secrets');
    first.initSecrets();
    const jwt1 = first.jwtSigningSecret();

    jest.resetModules();
    const second = await import('../secrets');
    second.initSecrets();
    expect(second.jwtSigningSecret()).toBe(jwt1);
    expect(second.getSecretsInfo().jwtSource).toBe('persisted');
  });

  it('prefers a strong env secret over generating one', async () => {
    process.env.JWT_SECRET = 'a'.repeat(40);
    const secrets = await import('../secrets');
    const info = secrets.initSecrets();
    expect(info.jwtSource).toBe('env');
    expect(secrets.jwtSigningSecret()).toBe('a'.repeat(40));
  });

  it('never accepts a known-default JWT secret as strong', async () => {
    process.env.JWT_SECRET = 'changeme_use_a_long_random_secret';
    const secrets = await import('../secrets');
    const info = secrets.initSecrets();
    expect(info.jwtSource).toBe('generated');
    expect(secrets.jwtVerifierSecrets()).not.toContain('changeme_use_a_long_random_secret');
  });

  it('ignores the JWT_SECRET that .env.example used to ship with', async () => {
    // Over 32 characters, so it used to pass as strong: every quick-start install
    // signed sessions with a string published in the repo.
    const placeholder = 'changeme_use_a_long_random_secret_at_least_32_chars';
    process.env.JWT_SECRET = placeholder;
    const secrets = await import('../secrets');
    const info = secrets.initSecrets();
    expect(info.jwtSource).toBe('generated');
    expect(info.envJwtIgnored).toBe(true);
    expect(secrets.jwtSigningSecret()).not.toBe(placeholder);
    expect(secrets.jwtVerifierSecrets()).not.toContain(placeholder);
  });

  it('treats any long changeme… value as a placeholder', async () => {
    process.env.JWT_SECRET = 'changeme-please-this-is-long-enough-to-pass';
    const secrets = await import('../secrets');
    expect(secrets.initSecrets().jwtSource).toBe('generated');
  });

  it('decrypts ciphertext written under the old default key after self-heal', async () => {
    // Legacy data on disk: encrypted under the old built-in default key.
    const legacyCipher = legacyEncrypt('router-admin-pw', 'changeme32byteslongencryptionkey');

    // Boot with no env key → auto-generate a new current key.
    const crypto = await import('../crypto');
    expect(crypto.decrypt(legacyCipher)).toBe('router-admin-pw');    // legacy fallback works
    expect(crypto.needsReencryption(legacyCipher)).toBe(true);        // flagged for forward migration
    expect(crypto.needsReencryption(crypto.encrypt('x'))).toBe(false); // current-key data is not
  });
});
