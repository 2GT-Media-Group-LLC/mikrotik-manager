import { encrypt, decrypt } from '../crypto';

describe('encrypt / decrypt', () => {
  it('round-trips plaintext', () => {
    const plain = 'super-secret-password';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('round-trips unicode', () => {
    const plain = 'пароль-123-密码';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('round-trips empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('produces different ciphertext on each call due to random IV', () => {
    const plain = 'same-text';
    expect(encrypt(plain)).not.toBe(encrypt(plain));
  });

  it('throws on invalid format (fewer than 3 colon-separated parts)', () => {
    expect(() => decrypt('notvalidformat')).toThrow('Invalid encrypted text format');
  });

  it('throws when ciphertext is tampered', () => {
    const enc = encrypt('hello');
    const parts = enc.split(':');
    parts[2] = 'deadbeef';
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
});
