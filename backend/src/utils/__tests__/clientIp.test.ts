import { clientIpBehindProxy } from '../clientIp';

// Outside review P2-33.
describe('clientIpBehindProxy', () => {
  it('takes the address nginx saw, the last X-Forwarded-For entry', () => {
    expect(clientIpBehindProxy('192.168.1.50', '172.24.0.5')).toBe('192.168.1.50');
  });
  it('ignores entries the client put there itself', () => {
    expect(clientIpBehindProxy('6.6.6.6, 192.168.1.50', '172.24.0.5')).toBe('192.168.1.50');
  });
  it('falls back to the socket peer without a header', () => {
    expect(clientIpBehindProxy(undefined, '::ffff:10.0.0.9')).toBe('10.0.0.9');
  });
});
