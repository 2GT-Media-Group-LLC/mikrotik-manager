import { resolveKeyCredentials } from '../sshKeyCredentials';

describe('resolveKeyCredentials', () => {
  it('uses stored SSH credentials when both are set', () => {
    expect(resolveKeyCredentials({ ssh_username: 'backup', ssh_password_encrypted: 'S', api_username: 'admin', api_password_encrypted: 'A' }))
      .toEqual({ ok: true, username: 'backup', passwordEncrypted: 'S', source: 'ssh' });
  });

  it('falls back to the API login as a pair when no SSH credentials exist', () => {
    expect(resolveKeyCredentials({ api_username: 'admin', api_password_encrypted: 'A' }))
      .toEqual({ ok: true, username: 'admin', passwordEncrypted: 'A', source: 'api' });
  });

  it('uses the API password when the SSH username is the API user', () => {
    expect(resolveKeyCredentials({ ssh_username: 'admin', api_username: 'admin', api_password_encrypted: 'A' }))
      .toMatchObject({ ok: true, username: 'admin', source: 'api' });
  });

  it("never pairs one account's name with another's password", () => {
    const r = resolveKeyCredentials({ ssh_username: 'backup', api_username: 'admin', api_password_encrypted: 'A' });
    expect(r.ok).toBe(false);
  });

  it('refuses a password without a username', () => {
    expect(resolveKeyCredentials({ ssh_password_encrypted: 'S', api_username: 'admin', api_password_encrypted: 'A' }).ok).toBe(false);
  });

  it('refuses when there is nothing to log in with', () => {
    expect(resolveKeyCredentials({}).ok).toBe(false);
  });

  it('treats a whitespace username as unset', () => {
    expect(resolveKeyCredentials({ ssh_username: '  ', api_username: 'admin', api_password_encrypted: 'A' }))
      .toMatchObject({ ok: true, source: 'api' });
  });
});

import { classifyKeyTarget } from '../sshKeyCredentials';

describe('classifyKeyTarget', () => {
  const base = { status: 'online', api_username: 'admin', api_password_encrypted: 'A' };
  it('counts an already-keyed device as keyed, not eligible', () => {
    expect(classifyKeyTarget({ ...base, has_verified_key: true })).toEqual({ kind: 'keyed' });
  });
  it('skips offline devices', () => {
    expect(classifyKeyTarget({ ...base, status: 'offline' })).toEqual({ kind: 'skip', reason: 'Offline.' });
  });
  it('names the account that will be keyed', () => {
    expect(classifyKeyTarget(base)).toEqual({ kind: 'eligible', username: 'admin', source: 'api' });
  });
});
