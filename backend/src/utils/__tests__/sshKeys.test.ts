import {
  generateDeviceKeyPair, fingerprintPublicKey, isUsablePrivateKey,
  keyComment, keyFileName, preferredAuth, keyTypeForVersion, importRejection,
} from '../sshKeys';

describe('generateDeviceKeyPair', () => {
  const kp = generateDeviceKeyPair(42);

  it('produces an OpenSSH ed25519 pair', () => {
    expect(kp.keyType).toBe('ed25519');
    expect(kp.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(kp.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('produces a private key ssh2 can authenticate with', () => {
    // A key we cannot parse is a key that will fail at connect time, on a device
    // we may have just removed password access from.
    expect(isUsablePrivateKey(kp.privateKey)).toBe(true);
  });

  it('tags the public key exactly once', () => {
    // The generator appends the comment itself; appending again produced keys
    // tagged twice, which reads like a bug when seen on the device.
    const occurrences = kp.publicKey.split(keyComment(42)).length - 1;
    expect(occurrences).toBe(1);
    expect(kp.publicKey.trim().split(/\s+/)).toHaveLength(3);
  });

  it('tags the public key so it can be attributed on the device', () => {
    // An operator reading /user/ssh-keys/print must be able to tell which entry
    // this is. A key nobody can attribute is a key nobody dares remove.
    expect(kp.publicKey).toContain(keyComment(42));
    expect(keyFileName(42)).toBe('mm-device-42.pub');
  });

  it('never repeats a key across devices', () => {
    const a = generateDeviceKeyPair(1), b = generateDeviceKeyPair(2);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('fingerprintPublicKey', () => {
  it('is stable and OpenSSH-shaped', () => {
    const kp = generateDeviceKeyPair(7);
    expect(kp.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fingerprintPublicKey(kp.publicKey)).toBe(kp.fingerprint);
  });

  it('ignores the comment, so re-tagging does not change identity', () => {
    const kp = generateDeviceKeyPair(8);
    const [type, b64] = kp.publicKey.split(/\s+/);
    expect(fingerprintPublicKey(`${type} ${b64} someone-elses-comment`)).toBe(kp.fingerprint);
  });
});

describe('isUsablePrivateKey', () => {
  it('rejects junk rather than failing later at connect time', () => {
    expect(isUsablePrivateKey('not a key')).toBe(false);
    expect(isUsablePrivateKey('')).toBe(false);
  });
});

describe('preferredAuth', () => {
  it('uses the key whenever one is installed', () => {
    // Not a preference: RouterOS refuses password SSH for a user once a key is
    // bound to them, confirmed on hardware by removing the key and watching
    // password login start working again.
    expect(preferredAuth('verified', true, true)).toBe('key');
    // Pushed but never proved: not yet evidence the device will accept it.
    expect(preferredAuth('deployed', true, true)).toBe('password');
  });

  it('uses the password only when no key is installed', () => {
    expect(preferredAuth(null, false, true)).toBe('password');
    expect(preferredAuth('failed', false, true)).toBe('password');
  });

  it('reports honestly when there is nothing to authenticate with', () => {
    expect(preferredAuth(null, false, false)).toBe('none');
  });
});

describe('key comments', () => {
  it('are unique per key, not per device', () => {
    // Sharing one comment across a device's keys meant removing "the old key"
    // during a rotation removed the new one too, taking SSH with it.
    const a = generateDeviceKeyPair(5), b = generateDeviceKeyPair(5);
    expect(a.comment).not.toBe(b.comment);
    expect(a.comment.startsWith(keyComment(5))).toBe(true);
    expect(a.publicKey.trim().split(/\s+/).pop()).toBe(a.comment);
  });
});

// Stanley's report (#85 discussion): on RouterOS 6.49.22 an Ed25519 key was
// accepted by /user/ssh-keys/import but every login with it failed. RouterOS
// only takes Ed25519 user keys from 7.12.
describe('key type by RouterOS version', () => {
  it('uses Ed25519 from 7.12 and RSA before that', () => {
    expect(keyTypeForVersion('7.24.4')).toBe('ed25519');
    expect(keyTypeForVersion('7.12')).toBe('ed25519');
    expect(keyTypeForVersion('7.11.2')).toBe('rsa');
    expect(keyTypeForVersion('6.49.22')).toBe('rsa');
  });

  it('uses RSA when the version is unknown, since every release accepts it', () => {
    expect(keyTypeForVersion(null)).toBe('rsa');
    expect(keyTypeForVersion('')).toBe('rsa');
  });

  it('generates a usable RSA key with the device comment', () => {
    const pair = generateDeviceKeyPair(7, 'abcd1234', 'rsa');
    expect(pair.keyType).toBe('rsa');
    expect(pair.publicKey).toMatch(/^ssh-rsa \S+ mikrotik-manager-device-7-abcd1234$/);
    expect(isUsablePrivateKey(pair.privateKey)).toBe(true);
  });
});

// The rest of Stanley's report: the manager sent /user/ssh-keys/import, which
// RouterOS 6 answers with a CLI parse error. The old check didn't treat that
// as a failure, so a key that was never imported was reported as installed.
describe('importRejection', () => {
  it('accepts the empty output a successful import prints', () => {
    expect(importRejection('')).toBeNull();
    expect(importRejection('  \r\n')).toBeNull();
  });

  it('catches the CLI parse error RouterOS 6 gives for v7 menu paths', () => {
    expect(importRejection('expected command name (line 1 column 6)')).toMatch(/expected command name/);
    expect(importRejection('syntax error (line 1 column 20)')).toMatch(/syntax error/);
    expect(importRejection('bad command name import (line 1 column 15)')).toMatch(/bad command/);
  });

  it('catches import failures RouterOS reports in words', () => {
    expect(importRejection('failure: no such item')).toMatch(/failure/);
    expect(importRejection('input does not match any value of user')).toMatch(/does not match/);
  });
});
