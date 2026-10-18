import { coveringPrefixes, readCoveringRoutes, readApiConnections } from '../targetedReads';

describe('targeted reads (#313)', () => {
  it('lists every IPv4 prefix that can hold an address, longest first', () => {
    const p = coveringPrefixes('192.168.10.77');
    expect(p).toHaveLength(33);
    expect(p[0]).toBe('192.168.10.77/32');
    expect(p).toContain('192.168.10.64/26');
    expect(p).toContain('192.168.0.0/16');
    expect(p).toContain('128.0.0.0/1');
    expect(p[32]).toBe('0.0.0.0/0');
  });

  it('writes IPv6 prefixes the way RouterOS does', () => {
    const p = coveringPrefixes('2001:db8:0:1::25');
    expect(p).toHaveLength(129);
    expect(p[0]).toBe('2001:db8:0:1::25/128');
    expect(p).toContain('2001:db8:0:1::/64');
    expect(p).toContain('2001:db8::/32');
    expect(p[128]).toBe('::/0');
  });

  it('asks only for those prefixes and the host itself, and merges what comes back', async () => {
    const asked: string[] = [];
    const reader = {
      executeMany: async (reads: { queries?: string[] }[]) => reads.map((r) => {
        const q = r.queries![0];
        asked.push(q);
        if (q === '?dst-address=0.0.0.0/0') return { rows: [{ '.id': '*1', 'dst-address': '0.0.0.0/0' }] };
        if (q === '?dst-address=10.0.0.0/8') return { rows: [{ '.id': '*2', 'dst-address': '10.0.0.0/8' }] };
        return { rows: [] };
      }),
    };
    const rows = await readCoveringRoutes(reader, '10.1.2.3');
    expect(rows.map((r) => r['.id'])).toEqual(['*2', '*1']);
    expect(asked).toHaveLength(34);
    expect(asked).toContain('?dst-address=10.1.2.3');
  });

  it('only the default route when the manager address is unknown', async () => {
    const asked: string[] = [];
    await readCoveringRoutes({ executeMany: async (reads) => { reads.forEach((r) => asked.push(r.queries![0])); return reads.map(() => ({ rows: [] })); } }, null);
    expect(asked).toEqual(['?dst-address=0.0.0.0/0']);
  });

  it('a failed read fails Change Guard rather than reading as no routes', async () => {
    const failing = { executeMany: async (reads: unknown[]) => reads.map(() => ({ error: new Error('no permission') })) };
    await expect(readCoveringRoutes(failing, '10.1.2.3')).rejects.toThrow('no permission');
    await expect(readCoveringRoutes(failing, '10.1.2.3', 4, false)).resolves.toEqual([]);
  });

  it('asks connection tracking for the API port both ways RouterOS writes it', async () => {
    const asked: string[][] = [];
    await readApiConnections({ executeMany: async (reads) => { reads.forEach((r) => asked.push(r.queries!)); return reads.map(() => ({ rows: [] })); } }, '192.0.2.5', 8729);
    expect(asked).toEqual([['?dst-address=192.0.2.5', '?dst-port=8729'], ['?dst-address=192.0.2.5:8729']]);
  });
});
