import { describe, it, expect, beforeEach, vi } from 'vitest';

// The store persists to localStorage, which the test environment doesn't have.
vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
});

import { useAuthStore } from './authStore';
import { useSiteStore } from './siteStore';

// Outside review P1-7: a site-limited account's interface role.
describe('authStore site access', () => {
  beforeEach(() => useAuthStore.getState().logout());

  it('leaves a fleet-wide account as it is', () => {
    useAuthStore.getState().setAuth('t', { id: 1, username: 'a', role: 'admin' });
    expect(useAuthStore.getState().user?.role).toBe('admin');
    expect(useAuthStore.getState().user?.siteRoles).toBeUndefined();
  });

  it('gives a site-limited account its highest site role, capped at operator', () => {
    useAuthStore.getState().setAuth('t', { id: 2, username: 'b', role: 'viewer', siteRoles: { 3: 'admin', 4: 'viewer' } });
    expect(useAuthStore.getState().user?.role).toBe('operator');
  });

  it('follows access changes from the server', () => {
    useAuthStore.getState().setAuth('t', { id: 2, username: 'b', role: 'viewer' });
    useAuthStore.getState().applyAccess({ role: 'viewer', siteRoles: { 3: 'operator' } });
    expect(useAuthStore.getState().user?.siteRoles).toEqual({ 3: 'operator' });
    expect(useAuthStore.getState().user?.role).toBe('operator');
    useAuthStore.getState().applyAccess({ role: 'admin', siteRoles: null });
    expect(useAuthStore.getState().user?.siteRoles).toBeUndefined();
    expect(useAuthStore.getState().user?.role).toBe('admin');
  });
});

// The site selection is remembered in the browser across sign-ins. Another
// account's site must not follow a site-limited account in, or every request it
// makes is refused and the interface is blank.
describe('site selection across sign-ins', () => {
  beforeEach(() => { useAuthStore.getState().logout(); useSiteStore.getState().setCurrentSite(null); });

  it("drops the previous account's site and lands a one-site account on its site", () => {
    useSiteStore.getState().setCurrentSite(1);
    useAuthStore.getState().setAuth('t', { id: 11, username: 'site-admin', role: 'admin', siteRoles: { 3: 'admin' } });
    expect(useSiteStore.getState().currentSiteId).toBe(3);
  });

  it('uses the all-sites view for an account with several sites', () => {
    useSiteStore.getState().setCurrentSite(1);
    useAuthStore.getState().setAuth('t', { id: 12, username: 'b', role: 'viewer', siteRoles: { 3: 'viewer', 4: 'operator' } });
    expect(useSiteStore.getState().currentSiteId).toBeNull();
  });

  it('keeps a site the account does have', () => {
    useSiteStore.getState().setCurrentSite(4);
    useAuthStore.getState().setAuth('t', { id: 12, username: 'b', role: 'viewer', siteRoles: { 3: 'viewer', 4: 'operator' } });
    expect(useSiteStore.getState().currentSiteId).toBe(4);
  });

  it("leaves a fleet-wide account's selection alone", () => {
    useSiteStore.getState().setCurrentSite(1);
    useAuthStore.getState().setAuth('t', { id: 1, username: 'a', role: 'admin' });
    expect(useSiteStore.getState().currentSiteId).toBe(1);
  });

  it('drops a site the account loses while signed in', () => {
    useAuthStore.getState().setAuth('t', { id: 12, username: 'b', role: 'viewer', siteRoles: { 3: 'viewer', 4: 'operator' } });
    useSiteStore.getState().setCurrentSite(4);
    useAuthStore.getState().applyAccess({ role: 'viewer', siteRoles: { 3: 'viewer' } });
    expect(useSiteStore.getState().currentSiteId).toBe(3);
  });
});
