import { query, queryOne } from '../config/database';
import { decrypt } from '../utils/crypto';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import { createDeviceFromBody } from './deviceCreation';
import type { PollerService } from './PollerService';
import {
  collectCandidates, pickTempAddress, validateTargetAddress, buildAdoptionOps,
  fetchAuthHeader, needsJumpHost, stripPrefix, TEMP_COMMENT,
  type AdoptionCandidate, type NeighborRow, type RestOp,
} from '../utils/adoption';

/**
 * Adopting a factory-default device by borrowing a managed neighbour.
 *
 * The decision-making lives in `utils/adoption.ts` and is unit tested; this is
 * the part that touches hardware. Its central obligation is that the jump host
 * — very possibly a production switch — is left exactly as it was found. Every
 * path out of `adopt()` removes the temporary address, and anything it creates
 * is commented so `cleanupOrphans()` can find it if the process dies first.
 */

export interface AdoptionRequest {
  /** MAC of the device to adopt, as reported by neighbour discovery. */
  mac: string;
  /** Managed device to borrow. Must be one that can see the target. */
  jumpHostId: number;
  /** Permanent address for the device, on the manager's subnet. */
  targetAddress: string;
  gateway: string;
  /** The unique password printed on the unit. */
  password: string;
  username?: string;
  identity?: string;
  /** Name to register it under. Defaults to the identity. */
  name?: string;
  /** Remove the factory 192.168.88.1 once the new address is proven. */
  removeFactoryAddress?: boolean;
  siteId?: number | null;
}

export interface AdoptionStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface AdoptionResult {
  ok: boolean;
  steps: AdoptionStep[];
  deviceId?: number;
  error?: string;
}

export class DeviceAdoptionService {
  constructor(private poller: PollerService | null = null) {}

  /**
   * Devices we can see but do not manage.
   *
   * Neighbour rows already carry everything needed; nothing extra is polled.
   */
  async listCandidates(): Promise<(AdoptionCandidate & { reachableDirectly: boolean })[]> {
    const rows = await query<NeighborRow>(
      `SELECT t.neighbor_mac, t.neighbor_address, t.neighbor_identity,
              t.neighbor_platform, t.from_device_id, t.from_interface, t.discovered_at
         FROM topology_links t
        WHERE t.to_device_id IS NULL
          AND t.neighbor_mac IS NOT NULL`
    );

    const managed = await query<{ ip_address: string }>(`SELECT ip_address FROM devices`);
    const managedIps = managed.map((m) => m.ip_address);

    // A neighbour whose MAC already belongs to a managed device is not a
    // candidate — it is a device we run, seen from an angle we have not matched.
    const knownMacs = new Set(
      (await query<{ mac_address: string }>(
        `SELECT DISTINCT UPPER(mac_address) AS mac_address FROM interfaces WHERE mac_address IS NOT NULL`
      )).map((r) => r.mac_address)
    );

    return collectCandidates(rows)
      .filter((c) => !knownMacs.has(c.mac))
      .map((c) => ({ ...c, reachableDirectly: !needsJumpHost(c.address, managedIps) }));
  }

  /** Remove temporary addresses a previous run failed to clean up. */
  async cleanupOrphans(): Promise<number> {
    const devices = await query<DeviceRow>(
      `SELECT id, name, ip_address, api_port, api_username, api_password_encrypted FROM devices`
    );
    let removed = 0;
    for (const d of devices) {
      let client: RouterOSClient | null = null;
      try {
        client = await this.connect(d);
        const addrs = await client.execute('/ip/address/print', { detail: '' });
        for (const a of addrs) {
          if ((a.comment || '').includes(TEMP_COMMENT)) {
            await client.execute('/ip/address/remove', { '.id': a['.id'] });
            removed++;
            console.log(`[Adopt] removed orphaned temp address ${a.address} from ${d.name}`);
          }
        }
      } catch {
        // An unreachable device cannot be cleaned now; the next sweep retries.
      } finally {
        client?.disconnect();
      }
    }
    return removed;
  }

  async adopt(req: AdoptionRequest): Promise<AdoptionResult> {
    const steps: AdoptionStep[] = [];
    const note = (step: string, ok: boolean, detail?: string) => {
      steps.push({ step, ok, detail });
      console.log(`[Adopt] ${ok ? 'ok  ' : 'FAIL'} ${step}${detail ? ` — ${detail}` : ''}`);
    };

    const candidate = (await this.listCandidates()).find(
      (c) => c.mac.toUpperCase() === req.mac.toUpperCase()
    );
    if (!candidate) return { ok: false, steps, error: `No unmanaged neighbour with MAC ${req.mac}` };
    if (!candidate.seenBy.includes(req.jumpHostId)) {
      return {
        ok: false, steps,
        error: `Device ${req.jumpHostId} cannot see ${req.mac}; it must be on the same broadcast domain`,
      };
    }

    const jump = await queryOne<DeviceRow>(
      `SELECT id, name, ip_address, api_port, api_username, api_password_encrypted
         FROM devices WHERE id = $1`, [req.jumpHostId]
    );
    if (!jump) return { ok: false, steps, error: 'Jump host not found' };

    // The permanent address is checked against the jump host's own address,
    // because that is demonstrably a subnet the manager can already reach.
    const verdict = validateTargetAddress(
      req.targetAddress, jump.ip_address, 24, [jump.ip_address]
    );
    if (!verdict.ok) return { ok: false, steps, error: verdict.reason };

    let client: RouterOSClient | null = null;
    let tempId: string | null = null;

    try {
      client = await this.connect(jump);
      note(`connected to jump host ${jump.name}`, true);

      const existing = (await client.execute('/ip/address/print', { detail: '' })).map((a) => a.address);
      const temp = pickTempAddress(candidate.address, existing);
      if (!temp) return { ok: false, steps, error: 'No free temporary address in the target subnet' };

      await client.execute('/ip/address/add', {
        address: temp, interface: 'bridge', comment: TEMP_COMMENT,
      });
      await sleep(2500);
      const added = (await client.execute('/ip/address/print', { detail: '' }))
        .find((a) => stripPrefix(a.address || '') === stripPrefix(temp));
      tempId = added?.['.id'] ?? null;
      note(`temporary address ${temp} on ${jump.name}`, true);

      const ping = await client.execute('/ping', { address: candidate.address, count: '3' }, [], { timeoutMs: 20000 });
      const recv = Number((ping[ping.length - 1] || {}).received || 0);
      if (recv === 0) return { ok: false, steps, error: `${candidate.address} did not answer ping from ${jump.name}` };
      note(`reached ${candidate.address}`, true, `${recv}/3 replies`);

      const headers = fetchAuthHeader(req.username || 'admin', req.password);
      const rest = (op: RestOp) => this.rest(client!, candidate.address, headers, op);

      // A read first: it proves the password before anything is written, so a
      // wrong sticker password fails harmlessly instead of part-way through.
      const probe = await rest({ method: 'get', path: 'system/resource', describe: 'authenticate' });
      if (!probe.ok) {
        return {
          ok: false, steps,
          error: 'Could not authenticate to the device. Check the password printed on the unit.',
        };
      }
      note('authenticated to target', true);

      for (const op of buildAdoptionOps({
        targetAddress: `${stripPrefix(req.targetAddress)}/24`,
        gateway: req.gateway,
        identity: req.identity,
      })) {
        const r = await rest(op);
        note(op.describe, r.ok, r.error);
        if (!r.ok) return { ok: false, steps, error: `Failed to ${op.describe}: ${r.error}` };
        await sleep(2000);
      }
    } catch (err) {
      return { ok: false, steps, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Runs on every path, including the early returns above.
      if (client && tempId) {
        try {
          await client.execute('/ip/address/remove', { '.id': tempId });
          note('removed temporary address from jump host', true);
        } catch (e) {
          note('removed temporary address from jump host', false,
            e instanceof Error ? e.message : String(e));
        }
      }
      client?.disconnect();
    }

    // From here the manager talks to the device directly; the jump host is done.
    const ip = stripPrefix(req.targetAddress);
    const reachable = await this.verifyDirect(ip, req.username || 'admin', req.password);
    note(`manager reached ${ip} over the API`, reachable);
    if (!reachable) {
      return { ok: false, steps, error: `Configured, but ${ip} is not answering the API from the manager` };
    }

    if (req.removeFactoryAddress) {
      const dropped = await this.removeFactoryAddress(ip, req.username || 'admin', req.password);
      note('removed factory 192.168.88.1 address', dropped.ok, dropped.detail);
    }

    const created = await createDeviceFromBody(
      {
        name: req.name || req.identity || `mikrotik-${req.mac.slice(-5).replace(':', '')}`,
        ip_address: ip,
        api_username: req.username || 'admin',
        api_password: req.password,
        device_type: 'switch',
      },
      this.poller,
      { siteId: req.siteId ?? null }
    );
    if (!created.ok) {
      note('registered in the manager', false, JSON.stringify(created.body));
      return { ok: false, steps, error: `Device configured but registration failed: ${JSON.stringify(created.body)}` };
    }
    note('registered in the manager', true);

    return { ok: true, steps, deviceId: Number(created.body.id) };
  }

  /** One REST call to the target, tunnelled through the jump host's `/tool/fetch`. */
  private async rest(
    client: RouterOSClient, target: string, headers: string, op: RestOp
  ): Promise<{ ok: boolean; data?: string; error?: string }> {
    const params: Record<string, string> = {
      url: `http://${target}/rest/${op.path}`,
      'http-method': op.method,
      'http-header-field': headers,
      output: 'user',
    };
    if (op.body) params['http-data'] = JSON.stringify(op.body);

    try {
      const res = await client.execute('/tool/fetch', params, [], { timeoutMs: 25000 });
      const row = res[res.length - 1] || {};
      if (row.status && row.status !== 'finished') {
        return { ok: false, error: `fetch status ${row.status}` };
      }
      return { ok: true, data: row.data };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // RouterOS REST answers a bad password with a 401 carrying no
      // www-authenticate header, which fetch reports as a parse error. Left raw
      // it reads like a protocol bug rather than a wrong password.
      if (/401/.test(msg)) return { ok: false, error: 'authentication rejected (401)' };
      return { ok: false, error: msg };
    }
  }

  private async verifyDirect(ip: string, user: string, pass: string): Promise<boolean> {
    const c = new RouterOSClient(ip, 8728, user, pass, 15000);
    try {
      await c.connect();
      await c.execute('/system/resource/print');
      return true;
    } catch {
      return false;
    } finally {
      c.disconnect();
    }
  }

  private async removeFactoryAddress(
    ip: string, user: string, pass: string
  ): Promise<{ ok: boolean; detail?: string }> {
    const c = new RouterOSClient(ip, 8728, user, pass, 15000);
    try {
      await c.connect();
      const addrs = await c.execute('/ip/address/print', { detail: '' });
      const factory = addrs.find((a) => stripPrefix(a.address || '') === '192.168.88.1');
      if (!factory) return { ok: true, detail: 'not present' };
      await c.execute('/ip/address/remove', { '.id': factory['.id'] });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      c.disconnect();
    }
  }

  private async connect(d: DeviceRow): Promise<RouterOSClient> {
    const c = new RouterOSClient(
      d.ip_address, d.api_port || 8728, d.api_username,
      decrypt(d.api_password_encrypted), 15000
    );
    await c.connect();
    return c;
  }
}

interface DeviceRow {
  id: number;
  name: string;
  ip_address: string;
  api_port: number;
  api_username: string;
  api_password_encrypted: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const deviceAdoptionService = new DeviceAdoptionService();
