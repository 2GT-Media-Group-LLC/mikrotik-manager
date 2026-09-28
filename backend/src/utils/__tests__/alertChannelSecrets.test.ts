import { maskConfig, mergeConfig } from '../alertChannelSecrets';

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

  it('accepts a new server when the token is typed again', () => {
    const r = mergeConfig('ntfy', { server_url: 'https://ntfy.sh', token: 'old' }, { server_url: 'https://ntfy.lan', token: 'new' });
    expect(r).toEqual({ merged: { server_url: 'https://ntfy.lan', token: 'new' } });
  });
});
