import { parseTrustedProxies } from '../trustedProxies';

describe('parseTrustedProxies', () => {
    it('is disabled when unset or empty', () => {
        for (const raw of [undefined, '', '  ', ',']) {
            const proxies = parseTrustedProxies(raw);
            expect(proxies.enabled).toBe(false);
            expect(proxies.entries).toEqual([]);
            expect(proxies.matches('10.0.0.1')).toBe(false);
        }
    });

    it('matches IPv4 addresses and CIDR ranges', () => {
        const proxies = parseTrustedProxies('10.0.0.5, 172.18.0.0/16');
        expect(proxies.enabled).toBe(true);
        expect(proxies.matches('10.0.0.5')).toBe(true);
        expect(proxies.matches('10.0.0.6')).toBe(false);
        expect(proxies.matches('172.18.9.4')).toBe(true);
        expect(proxies.matches('172.19.9.4')).toBe(false);
    });

    it('matches IPv6 addresses and CIDR ranges', () => {
        const proxies = parseTrustedProxies('2001:db8::1 2001:db8:2::/64');
        expect(proxies.matches('2001:db8::1')).toBe(true);
        expect(proxies.matches('2001:db8:2::abcd')).toBe(true);
        expect(proxies.matches('2001:db8:3::1')).toBe(false);
    });

    it('matches IPv4-mapped IPv6 peers against IPv4 entries', () => {
        const proxies = parseTrustedProxies('10.0.0.5');
        expect(proxies.matches('::ffff:10.0.0.5')).toBe(true);
        expect(proxies.matches('::ffff:10.0.0.6')).toBe(false);
    });

    it('rejects malformed entries instead of silently ignoring them', () => {
        for (const raw of ['nginx', '10.0.0.0/33', '10.0.0.0/nope', '10.0.0.0/8/1', '2001:db8::/129']) {
            expect(() => parseTrustedProxies(raw)).toThrow(/BACKEND_TRUSTED_PROXIES/);
        }
    });

    it('ignores forwarded addresses from an untrusted peer', () => {
        const proxies = parseTrustedProxies('10.0.0.0/8');
        expect(proxies.clientIp('203.0.113.9', '192.0.2.5')).toBe('192.0.2.5');
    });

    it('takes the address the trusted proxy saw, not the client-supplied left entries', () => {
        const proxies = parseTrustedProxies('10.0.0.0/8');
        expect(proxies.clientIp('6.6.6.6, 198.51.100.7', '10.0.0.2')).toBe('198.51.100.7');
    });

    it('walks a multi-hop trusted chain', () => {
        const proxies = parseTrustedProxies('10.0.0.0/8, 172.16.0.0/12');
        expect(proxies.clientIp('198.51.100.7, 172.16.0.9', '10.0.0.2')).toBe('198.51.100.7');
    });

    it('returns the leftmost address when every hop is trusted', () => {
        const proxies = parseTrustedProxies('10.0.0.0/8, 172.16.0.0/12');
        expect(proxies.clientIp('172.16.0.9, 10.0.0.3', '10.0.0.2')).toBe('172.16.0.9');
    });

    it('falls back to the peer without a header', () => {
        const proxies = parseTrustedProxies('10.0.0.0/8');
        expect(proxies.clientIp(undefined, '10.0.0.2')).toBe('10.0.0.2');
        expect(proxies.clientIp(undefined, '::ffff:10.0.0.2')).toBe('10.0.0.2');
    });
});
