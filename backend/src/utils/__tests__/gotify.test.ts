import { buildGotifyRequest, gotifyPriority } from '../gotify';

describe('buildGotifyRequest (#169)', () => {
  it('posts to /message with the app token in a header, not the URL', () => {
    const r = buildGotifyRequest({ server_url: 'https://gotify.example.com/', app_token: 'Axyz' }, 'device_offline', 'Down', 'sw1 is down');
    expect(r.url).toBe('https://gotify.example.com/message');
    expect(r.headers).toEqual({ 'X-Gotify-Key': 'Axyz' });
    expect(JSON.parse(r.body)).toMatchObject({ title: 'Down', message: 'sw1 is down', priority: 8 });
  });

  it('keeps a sub-path install', () => {
    expect(buildGotifyRequest({ server_url: 'https://h.example/gotify', app_token: 't' }, 'x', 't', 'm').url)
      .toBe('https://h.example/gotify/message');
  });

  it('adds a click-through to the device when a manager URL is set', () => {
    const r = buildGotifyRequest({ server_url: 'https://g.example', app_token: 't', click_url: 'https://mm.example/' }, 'x', 't', 'm', 42);
    expect(JSON.parse(r.body).extras['client::notification'].click.url).toBe('https://mm.example/devices/42');
  });

  it('refuses a missing token, a missing server or a non-http URL', () => {
    expect(() => buildGotifyRequest({ server_url: 'https://g.example' }, 'x', 't', 'm')).toThrow(/app token/);
    expect(() => buildGotifyRequest({ app_token: 't' }, 'x', 't', 'm')).toThrow(/server URL/);
    expect(() => buildGotifyRequest({ server_url: 'file:///etc', app_token: 't' }, 'x', 't', 'm')).toThrow(/http/);
  });

  it('reserves high priority for things that are down or failing', () => {
    expect(gotifyPriority('device_offline')).toBe(8);
    expect(gotifyPriority('device_online')).toBe(2);
    expect(gotifyPriority('config_drift')).toBe(5);
  });
});
