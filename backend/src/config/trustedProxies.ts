import net from 'node:net';

/**
 * The proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` headers the API
 * believes. Compose's nginx is trusted by hop count (the historical behaviour);
 * a proxy chain can add hops, so it is named explicitly with
 * `BACKEND_TRUSTED_PROXIES` instead.
 */
export interface TrustedProxies {
    readonly enabled: boolean;
    readonly entries: readonly string[];
    matches(address: string | undefined): boolean;
    /**
     * The client address implied by an X-Forwarded-For chain, walking from the
     * socket peer towards the client and stopping at the first address not in
     * the list. The left-hand entries are whatever the client sent, so they are
     * only used once every address to their right is trusted.
     */
    clientIp(forwardedFor: string | string[] | undefined, peer: string | undefined): string;
}

function normalizeAddress(address: string): string {
    // Node reports an IPv4 peer on a dual-stack socket as ::ffff:a.b.c.d.
    if (address.toLowerCase().startsWith('::ffff:')) {
        const rest = address.slice('::ffff:'.length);
        if (net.isIP(rest) === 4) return rest;
    }
    return address;
}

function invalid(token: string): Error {
    return new Error(
        `BACKEND_TRUSTED_PROXIES entry "${token}" is not an IP address or CIDR range`
    );
}

function parseEntry(token: string, block: net.BlockList): void {
    const parts = token.split('/');
    if (parts.length > 2 || !parts[0]) throw invalid(token);
    const address = parts[0];
    const family = net.isIP(address);
    if (family === 0) throw invalid(token);
    const type = family === 4 ? 'ipv4' : 'ipv6';

    if (parts.length === 1) {
        block.addAddress(address, type);
        return;
    }

    const prefixText = parts[1];
    if (!/^\d+$/.test(prefixText)) throw invalid(token);
    const prefix = Number(prefixText);
    if (prefix > (family === 4 ? 32 : 128)) throw invalid(token);
    block.addSubnet(address, prefix, type);
}

/**
 * Parse `BACKEND_TRUSTED_PROXIES` (comma or whitespace separated addresses and
 * CIDR ranges, IPv4 or IPv6). Unset or empty leaves the historical one-hop
 * behaviour in place; a malformed entry throws so a typo cannot silently widen
 * what the API believes.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxies {
    const entries = (raw ?? '').split(/[\s,]+/).filter(Boolean);
    const block = new net.BlockList();
    for (const entry of entries) parseEntry(entry, block);

    const matches = (address: string | undefined): boolean => {
        if (!address) return false;
        const normalized = normalizeAddress(address);
        const family = net.isIP(normalized);
        if (family === 0) return false;
        return block.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
    };

    const clientIp = (
        forwardedFor: string | string[] | undefined,
        peer: string | undefined
    ): string => {
        const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
        const forwarded = (header ?? '')
            .split(',')
            .map((part) => normalizeAddress(part.trim()))
            .filter(Boolean)
            .reverse();
        const chain = [normalizeAddress(peer ?? ''), ...forwarded].filter(Boolean);
        if (chain.length === 0) return '';

        let current = chain[0];
        for (const candidate of chain) {
            if (!matches(candidate)) return candidate;
            current = candidate;
        }
        return current;
    };

    return { enabled: entries.length > 0, entries, matches, clientIp };
}
