jest.mock('../../config/database');
import { assertPublicHost } from '../WebhookService';

// GHSA-28hr-v457-cc6g: URL.hostname keeps IPv6 brackets, and the IPv4 inside a
// mapped address can be written in hex.
describe('webhook destination guard', () => {
  const host = (url: string) => new URL(url).hostname;

  it.each([
    'http://[::ffff:7f00:1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data',
    'http://[0:0:0:0:0:0:0:1]:3001/api',
    'http://[64:ff9b::7f00:1]/x',
    'http://[fd00::1]/x',
    'http://127.0.0.1/x',
  ])('refuses %s', async (url) => {
    await expect(assertPublicHost(host(url))).rejects.toThrow(/blocked/);
  });

  it('accepts a public IPv6 literal, without the brackets', async () => {
    await expect(assertPublicHost(host('https://[2606:4700:4700::1111]/hook'))).resolves.toBe('2606:4700:4700::1111');
  });
});
