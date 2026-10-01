/**
 * Minimum password policy applied wherever a password is set or changed.
 * Returns an error message if the password is unacceptable, or null if it's OK.
 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password must be a string';
  if (password.length < 10) return 'Password must be at least 10 characters long';
  // bcrypt only uses the first 72 bytes. Longer passwords were accepted, so
  // changing only the end of one left the old password still working
  // (outside review S6). Counted in UTF-8 bytes, not characters.
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return 'Password must be at most 72 bytes (72 characters, fewer with accented letters or symbols)';
  }
  if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}
