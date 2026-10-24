import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import type { AlignmentSnapshot } from './mikrotik/antennaAlignment';
import { usesApiTls } from '../utils/apiTls';

interface Session {
  key: string;
  collector: DeviceCollector;
  connected: boolean;
  pending?: Promise<AlignmentSnapshot>;
  snapshot?: AlignmentSnapshot;
  sampledAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class AlignmentCapacityError extends Error {}

/**
 * Share a native API session between viewers, with at most two reads/second per
 * radio. No background polling: inactive sessions close after ten seconds.
 * Authorization and the WISP category are checked by the route on every request.
 */
export class AntennaAlignmentService {
  private sessions = new Map<number, Session>();

  constructor(private maxSessions = 16, private idleMs = 10_000, private cacheMs = 500) {}

  private expire(id: number, session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (session.pending) { this.expire(id, session); return; }
      if (this.sessions.get(id) === session) this.remove(id);
    }, this.idleMs);
    session.timer.unref?.();
  }

  remove(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.timer) clearTimeout(session.timer);
    session.collector.disconnect();
  }

  close(): void {
    for (const id of this.sessions.keys()) this.remove(id);
  }

  async read(device: DeviceRow): Promise<AlignmentSnapshot> {
    // Address, credentials or API availability changed: do not reuse the login.
    const key = JSON.stringify([device.ip_address, device.api_port, device.api_username,
      device.api_password_encrypted, device.ssh_only, usesApiTls(device)]);
    let session = this.sessions.get(device.id);
    if (session && session.key !== key) { this.remove(device.id); session = undefined; }
    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        throw new AlignmentCapacityError('All alignment sessions are in use. Pause another aligner and try again in ten seconds.');
      }
      session = { key, collector: new DeviceCollector(device, { connectTimeoutMs: 5000, readTimeoutMs: 4000 }),
        connected: false, sampledAt: 0 };
      this.sessions.set(device.id, session);
    }
    const entry = session;
    this.expire(device.id, entry);
    if (entry.pending) return entry.pending;
    if (entry.snapshot && Date.now() - entry.sampledAt < this.cacheMs) return entry.snapshot;
    entry.pending = (async () => {
      // A device with many interfaces must not stretch a supposedly live read
      // indefinitely, even if each individual API command answers in time.
      const deadline = setTimeout(() => entry.collector.abort(), 15_000);
      deadline.unref?.();
      try {
        if (!entry.connected) { await entry.collector.connect(); entry.connected = true; }
        const snapshot = await entry.collector.readAntennaAlignment();
        entry.snapshot = snapshot;
        entry.sampledAt = Date.now();
        return snapshot;
      } catch (err) {
        if (this.sessions.get(device.id) === entry) this.remove(device.id);
        throw err;
      } finally {
        clearTimeout(deadline);
        entry.pending = undefined;
      }
    })();
    return entry.pending;
  }
}

export const antennaAlignment = new AntennaAlignmentService();
