import { validatePassword } from '../passwordPolicy';

describe('validatePassword', () => {
  it('accepts a normal password', () => expect(validatePassword('correct horse 42')).toBeNull());
  it('accepts exactly 72 bytes', () => expect(validatePassword('a1' + 'x'.repeat(70))).toBeNull());
  // Outside review S6: bcrypt ignores everything past 72 bytes.
  it('refuses more than 72 bytes', () => expect(validatePassword('a1' + 'x'.repeat(71))).toMatch(/72 bytes/));
  it('counts bytes, not characters', () => expect(validatePassword('a1' + 'é'.repeat(36))).toMatch(/72 bytes/)); // 74 bytes
  it('still requires length, a letter and a number', () => {
    expect(validatePassword('short1')).toMatch(/at least 10/);
    expect(validatePassword('1234567890')).toMatch(/letter/);
    expect(validatePassword('abcdefghij')).toMatch(/number/);
  });
});
