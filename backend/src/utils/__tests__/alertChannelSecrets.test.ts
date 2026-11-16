jest.mock('../crypto', () => ({ encrypt: (v: string) => `C:${v}`, decrypt: (v: string) => v.slice(2) }));
import { maskConfig, mergeConfig, sealConfig, openConfig, sealedSecretInput } from '../alertChannelSecrets';

const MASK = '••••••••';

describe('alert channel secrets', () => {
  it('masks Slack and Discord webhook URLs, which are credentials', () => {
    expect(maskConfig('slack', { webhook_url: 'https://hooks.slack.com/services/T/B/x' }).webhook_url).toBe(MASK);
    expect(maskConfig('discord', { webhook_url: 'https://discord.com/api/webhooks/1/x' }).webhook_url).toBe(MASK);
  });

  it('keeps a saved token when the mask comes back and nothing else moved', () => {
    const r = mergeConfig('gotify', { server_url: 'http://gotify.lan', app_token: 'secret' }, { server_url: 'http://gotify.lan', app_token: MASK });
    expect(r).toEqual({ merged: { server_url: 'http://gotify.lan', app_token: 'secret' } });
  });

  it('refuses to carry a saved token to a different server', () => {
    // Otherwise: edit the URL, keep the masked token, press Test, receive it.
    const r = mergeConfig('gotify', { server_url: 'http://gotify.lan', app_token: 'secret' }, { server_url: 'https://evil.example', app_token: MASK });
    expect('error' in r).toBe(true);
    const e = mergeConfig('email', { smtp_host: 'mail.lan', smtp_pass: 'pw' }, { smtp_host: 'evil.example', smtp_pass: MASK });
    expect('error' in e).toBe(true);
  });

  // GHSA-qm4w-hmcg-7rq9: leaving the secret out kept it just like the mask did, without the check.
  it('refuses a new server when the secret is left out of the request', () => {
    expect('error' in mergeConfig('ntfy', { server_url: 'https://ntfy.sh', token: 'old' }, { server_url: 'https://evil.example' })).toBe(true);
    expect('error' in mergeConfig('gotify', { server_url: 'http://g.lan', app_token: 't' }, { server_url: 'https://evil.example' })).toBe(true);
    expect('error' in mergeConfig('email', { smtp_host: 'mail.lan', smtp_pass: 'pw' }, { smtp_host: 'evil.example' })).toBe(true);
  });

  it('keeps a left-out secret when the server stays put', () => {
    expect(mergeConfig('ntfy', { server_url: 'https://ntfy.sh', token: 'old', topic: 'a' }, { topic: 'b' }))
      .toEqual({ merged: { server_url: 'https://ntfy.sh', token: 'old', topic: 'b' } });
  });

  it('treats turning email TLS protection off as a new destination', () => {
    expect('error' in mergeConfig('email', { smtp_host: 'mail.lan', smtp_pass: 'pw' }, { smtp_tls_verify: false })).toBe(true);
    expect('error' in mergeConfig('email', { smtp_host: 'mail.lan', smtp_pass: 'pw', smtp_secure: true }, { smtp_secure: false, smtp_pass: MASK })).toBe(true);
    // Turning it on, or sending what's already saved, is fine.
    expect('merged' in mergeConfig('email', { smtp_host: 'mail.lan', smtp_pass: 'pw', smtp_tls_verify: false }, { smtp_tls_verify: true, smtp_pass: MASK })).toBe(true);
    expect('merged' in mergeConfig('email', { smtp_host: 'mail.lan', smtp_pass: 'pw' }, { smtp_secure: false, smtp_tls_verify: true, smtp_pass: MASK })).toBe(true);
    // No saved password, nothing to protect.
    expect('merged' in mergeConfig('email', { smtp_host: 'mail.lan' }, { smtp_tls_verify: false })).toBe(true);
  });

  it('refuses a secret that arrives already encrypted', () => {
    expect('error' in mergeConfig('gotify', { server_url: 'http://g.lan', app_token: 'enc:C:mine' }, { app_token: 'enc:C:other' })).toBe(true);
    expect(sealedSecretInput('telegram', { chat_id: '1', bot_token: 'enc:C:x' })).toBe(true);
    expect(sealedSecretInput('telegram', { chat_id: '1', bot_token: '123:abc' })).toBe(false);
    // The channel's own saved value coming back changes nothing.
    expect('merged' in mergeConfig('gotify', { server_url: 'http://g.lan', app_token: 'enc:C:mine' }, { app_token: 'enc:C:mine' })).toBe(true);
  });

  it('accepts a new server when the token is typed again', () => {
    const r = mergeConfig('ntfy', { server_url: 'https://ntfy.sh', token: 'old' }, { server_url: 'https://ntfy.lan', token: 'new' });
    expect(r).toEqual({ merged: { server_url: 'https://ntfy.lan', token: 'new' } });
  });
});

// Outside review S7.
describe('alert channel secrets at rest', () => {
  it('encrypts only the secret fields, once', () => {
    const sealed = sealConfig('ntfy', { server_url: 'https://ntfy.sh', topic: 't', token: 'tk_123' });
    expect(sealed).toEqual({ server_url: 'https://ntfy.sh', topic: 't', token: 'enc:C:tk_123' });
    expect(sealConfig('ntfy', sealed)).toEqual(sealed);
  });

  it('opens them for sending', () => {
    expect(openConfig('telegram', { chat_id: '1', bot_token: 'enc:C:abc' })).toEqual({ chat_id: '1', bot_token: 'abc' });
  });

  it('still masks a sealed value and keeps it when the mask is sent back', () => {
    const stored = { smtp_host: 'mail', smtp_pass: 'enc:C:pw' };
    expect(maskConfig('email', stored).smtp_pass).toBe(MASK);
    const merged = mergeConfig('email', stored, { smtp_pass: MASK, smtp_user: 'me' });
    expect('merged' in merged && merged.merged.smtp_pass).toBe('enc:C:pw');
  });
});
