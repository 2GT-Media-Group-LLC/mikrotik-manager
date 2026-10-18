import { lease, dropSessions, pooledSessionCount } from '../sessionPool';
import type { RouterOSClient } from '../RouterOSClient';

/** A stand-in client: usable until disconnected or marked broken. */
function fakeClient() {
  const c = { usable: true, closed: 0, isUsable() { return this.usable; }, disconnect() { this.usable = false; this.closed++; } };
  return c as unknown as RouterOSClient & typeof c;
}

const dev = (id: number, over: Partial<{ ip_address: string; api_password_encrypted: string }> = {}) => ({
  id, ip_address: '10.0.0.1', api_port: 8729, api_username: 'admin', api_password_encrypted: 'enc-1', ...over,
});

describe('API session pool (#301)', () => {
  afterEach(() => { for (let i = 1; i < 20; i++) dropSessions(i); });

  it('reuses a session after a successful poll', () => {
    const a = fakeClient();
    const l1 = lease(dev(1), 'fast', true, () => a)!;
    expect(l1.fresh).toBe(true);
    l1.release(true);
    const l2 = lease(dev(1), 'fast', true, () => fakeClient())!;
    expect(l2.fresh).toBe(false);
    expect(l2.client).toBe(a);
    l2.release(true);
  });

  it('keeps fast and slow lanes apart', () => {
    const f = lease(dev(2), 'fast', true, () => fakeClient())!;
    const s = lease(dev(2), 'slow', true, () => fakeClient())!;
    expect(s.client).not.toBe(f.client);
    f.release(true); s.release(true);
  });

  it('a busy session is not shared: the caller connects on its own', () => {
    const l1 = lease(dev(3), 'fast', true, () => fakeClient())!;
    expect(lease(dev(3), 'fast', true, () => fakeClient())).toBeNull();
    l1.release(true);
    expect(lease(dev(3), 'fast', true, () => fakeClient())).not.toBeNull();
  });

  it('closes the session after a failed poll instead of handing it on', () => {
    const a = fakeClient();
    lease(dev(4), 'fast', true, () => a)!.release(false);
    expect(a.closed).toBe(1);
    expect(lease(dev(4), 'fast', true, () => fakeClient())!.fresh).toBe(true);
  });

  it('starts afresh when the address, password or TLS setting changed', () => {
    const a = fakeClient();
    lease(dev(5), 'fast', true, () => a)!.release(true);
    const moved = lease(dev(5, { ip_address: '10.0.0.2' }), 'fast', true, () => fakeClient())!;
    expect(moved.fresh).toBe(true);
    expect(a.closed).toBe(1);
    moved.release(true);
    expect(lease(dev(5, { ip_address: '10.0.0.2', api_password_encrypted: 'enc-2' }), 'fast', true, () => fakeClient())!.fresh).toBe(true);
  });

  it('a session that died between polls is replaced', () => {
    const a = fakeClient();
    lease(dev(6), 'fast', true, () => a)!.release(true);
    a.usable = false;
    expect(lease(dev(6), 'fast', true, () => fakeClient())!.fresh).toBe(true);
  });

  it('counts open sessions, and drops them on request', () => {
    lease(dev(7), 'fast', true, () => fakeClient())!.release(true);
    lease(dev(7), 'logs', true, () => fakeClient())!.release(true);
    lease(dev(7), 'slow', true, () => fakeClient())!.release(true);
    const before = pooledSessionCount();
    dropSessions(7);
    expect(pooledSessionCount()).toBe(before - 3);
  });
});
