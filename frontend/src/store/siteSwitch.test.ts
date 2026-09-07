import { describe, it, expect } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

/**
 * Why site switching is done by rekeying the QueryClient rather than clearing it.
 *
 * The first implementation called queryClient.clear() on switch and looked
 * correct in review: the cache really is emptied. But every already-rendered
 * page went on showing the previous site's data, because a *mounted* observer
 * keeps its own reference to the destroyed query and its last result, and
 * nothing re-subscribes it.
 *
 * These tests pin that behaviour down so the shortcut cannot come back.
 */

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });
}

/** Stands in for a page: subscribes and exposes what it would render. */
function mountObserver(client: QueryClient, fetcher: () => Promise<string>) {
  const observer = new QueryObserver(client, { queryKey: ['devices'], queryFn: fetcher });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe, current: () => observer.getCurrentResult().data };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('site switching and the query cache', () => {
  it('clear() does NOT update a mounted observer — this was the bug', async () => {
    const client = makeClient();
    let site = 'site-1';
    const { unsubscribe, current } = mountObserver(client, async () => `data-for-${site}`);
    await settle();
    expect(current()).toBe('data-for-site-1');

    // Switch site the way the broken version did.
    site = 'site-2';
    client.clear();
    await settle();

    // The cache is empty, yet the mounted page still renders site 1's data.
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(current()).toBe('data-for-site-1');
    unsubscribe();
  });

  it('a fresh QueryClient gives a mounted page the new site data', async () => {
    let site = 'site-1';
    const fetcher = async () => `data-for-${site}`;

    const first = makeClient();
    const a = mountObserver(first, fetcher);
    await settle();
    expect(a.current()).toBe('data-for-site-1');

    // What the keyed provider does: the subtree remounts against a new client.
    a.unsubscribe();
    site = 'site-2';
    const second = makeClient();
    const b = mountObserver(second, fetcher);
    await settle();

    expect(b.current()).toBe('data-for-site-2');
    // Nothing from the previous site survived into the new cache.
    expect(second.getQueryCache().getAll()).toHaveLength(1);
    b.unsubscribe();
  });

  it('invalidateQueries() does refetch a mounted observer', async () => {
    // The in-place alternative, used where the tree must not remount (moving a
    // device between sites from the device page).
    const client = makeClient();
    let site = 'site-1';
    const { unsubscribe, current } = mountObserver(client, async () => `data-for-${site}`);
    await settle();
    expect(current()).toBe('data-for-site-1');

    site = 'site-2';
    await client.invalidateQueries();
    await settle();

    expect(current()).toBe('data-for-site-2');
    unsubscribe();
  });
});
