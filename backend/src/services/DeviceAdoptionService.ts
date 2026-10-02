import { query, queryOne } from '../config/database';
import { decrypt } from '../utils/crypto';
import { logSafe } from '../utils/logSafe';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import { createDeviceFromBody } from './deviceCreation';
import type { PollerService } from './PollerService';
import {
  collectCandidates, tempAddressCandidates, validateTargetAddress,
  fetchAuthHeader, needsJumpHost, stripPrefix, TEMP_COMMENT,
  jumpInterface, detectDeviceType, hasMac,
  recommendMode, assessFactoryState, validatePlan, buildPlanOps, planInterface,
  leasedAddress, judgeConflict, arpRowResolved,
  type AdoptionCandidate, type NeighborRow, type RestOp, type ModeRecommendation,
  type AddressPlan,
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
  /**
   * How the device should be addressed: DHCP or static, optionally on a
   * management VLAN. Asked for rather than inferred — see AddressPlan.
   */
  plan: AddressPlan;
  /** The unique password printed on the unit. */
  password: string;
  username?: string;
  identity?: string;
  /** Name to register it under. Defaults to the identity. */
  name?: string;
  /** Remove the factory 192.168.88.1 once the new address is proven. */
  removeFactoryAddress?: boolean;
  /**
   * Proceed even though neighbour discovery suggests the device is already
   * configured. Overrides that pre-connection guess only: the check made
   * after logging in still stops adoption if the device isn't factory-default
   * (outside review C9), as the dialog and docs say.
   */
  force?: boolean;
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
  async listCandidates(): Promise<
    (AdoptionCandidate & { reachableDirectly: boolean; recommendation: ModeRecommendation })[]
  > {
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
      .map((c) => {
        const reachableDirectly = !needsJumpHost(c.address, managedIps);
        return {
          ...c,
          reachableDirectly,
          // Decided from what the device looks like, not from whether we can
          // reach it. An established switch we have no route to is still an
          // established switch.
          recommendation: recommendMode({
            address: c.address, identity: c.identity, reachableDirectly,
          }),
        };
      });
  }

  /** Free/in-use verdict for one address, seen from a managed device. */
  async checkAddress(jumpHostId: number, address: string): Promise<{ free: boolean; reason?: string }> {
    const jump = await queryOne<DeviceRow>(
      `SELECT id, name, ip_address, api_port, api_username, api_password_encrypted
         FROM devices WHERE id = $1`, [jumpHostId]
    );
    if (!jump) return { free: false, reason: 'jump host not found' };
    let client: RouterOSClient | null = null;
    try {
      client = await this.connect(jump);
      return await this.checkAddressFree(client, address);
    } catch (e) {
      return { free: false, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      client?.disconnect();
    }
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
      // detail can carry device-reported text (CodeQL alert #97).
      console.log(`[Adopt] ${ok ? 'ok  ' : 'FAIL'} ${logSafe(step)}${detail ? ` — ${logSafe(detail)}` : ''}`);
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

    const planVerdict = validatePlan(req.plan);
    if (!planVerdict.ok) return { ok: false, steps, error: planVerdict.reason };

    if (candidate.recommendation.mode !== 'adopt' && !req.force) {
      return {
        ok: false, steps,
        error: 'This device looks already configured (' + candidate.recommendation.reasons.join('; ') +
               '). Add it normally with its credentials, or confirm it is factory-default to continue.',
      };
    }

    // Where the jump host sees the target, so the temporary address goes on
    // that segment rather than on a guessed "bridge" (outside review C9).
    const seenOn = (await query<{ from_interface: string }>(
      `SELECT DISTINCT from_interface FROM topology_links
        WHERE from_device_id = $1 AND UPPER(neighbor_mac) = $2 AND from_interface IS NOT NULL`,
      [req.jumpHostId, candidate.mac]
    )).map((r) => r.from_interface);

    // A static address on the manager's own subnet is additionally checked for
    // reachability, since that is the case where a typo strands the device.
    // Addresses on a management VLAN are deliberately not second-guessed: the
    // manager has no visibility into that segment.
    if (req.plan.mode === 'static' && !req.plan.vlanId) {
      const reach = validateTargetAddress(
        req.plan.address, jump.ip_address, req.plan.prefix, [jump.ip_address]
      );
      if (!reach.ok) return { ok: false, steps, error: reach.reason };
    }

    let client: RouterOSClient | null = null;
    // Set before the add is sent, so cleanup runs even if the add's reply or
    // the read-back is lost (outside review C9).
    let temp: string | null = null;
    let learnedIp: string | null = null;
    let deviceType: 'router' | 'switch' | 'wireless_ap' | undefined;

    try {
      client = await this.connect(jump);
      note(`connected to jump host ${jump.name}`, true);

      const [addrRows, bridgePorts, ifaces] = await Promise.all([
        client.execute('/ip/address/print', { detail: '' }),
        client.execute('/interface/bridge/port/print'),
        client.execute('/interface/print'),
      ]);
      const iface = jumpInterface(seenOn, bridgePorts, ifaces);
      if (!iface) {
        return {
          ok: false, steps,
          error: `Couldn't tell which interface on ${jump.name} faces ${candidate.mac}. Nothing was changed.`,
        };
      }

      // A temporary address nobody on the segment is using (outside review
      // C9): the jump host's own list says nothing about other hosts.
      for (const option of tempAddressCandidates(candidate.address, addrRows.map((a) => a.address)).slice(0, 5)) {
        const check = await this.checkAddressFree(client, option, iface);
        if (check.free) { temp = option; break; }
        note(`temporary address ${option} is in use`, false, check.reason);
      }
      if (!temp) return { ok: false, steps, error: 'No free temporary address in the target subnet. Nothing was changed.' };

      const tempAddress = temp;
      await client.execute('/ip/address/add', { address: tempAddress, interface: iface, comment: TEMP_COMMENT });
      await sleep(2500);
      note(`temporary address ${tempAddress} on ${jump.name} ${iface}`, true);

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

      // The device answering on that address must be the one that was chosen
      // (outside review C9): two factory devices both sit on 192.168.88.1.
      const targetIfaces = await this.readMany(rest, 'interface');
      if (targetIfaces === null || !hasMac(targetIfaces, candidate.mac)) {
        note(`confirmed ${candidate.address} is ${candidate.mac}`, false);
        return {
          ok: false, steps,
          error: targetIfaces === null
            ? `Couldn't read the interfaces of the device at ${candidate.address} to confirm it is ${candidate.mac}. Nothing was changed.`
            : `The device answering at ${candidate.address} is not ${candidate.mac}. Nothing was changed. ` +
              'Another unadopted device may be on the same address; adopt one at a time.',
        };
      }
      note(`confirmed ${candidate.address} is ${candidate.mac}`, true);
      deviceType = detectDeviceType(this.parse(probe.data)?.['board-name'], targetIfaces);

      // Last harmless moment. Neighbour discovery exposes only an address and
      // an identity, which is enough to *suggest* a flow but not enough to bet
      // someone's production switch on. Now that we are authenticated we can
      // look properly, and decline if this turns out to be a device already in
      // service rather than one out of its box.
      // A read that fails is not evidence of a clean device (outside review
      // C9): unread, the check refuses.
      const identity = await this.readOne(rest, 'system/identity');
      const addresses = await this.readMany(rest, 'ip/address');
      const users = await this.readMany(rest, 'user');
      if (!identity || addresses === null || users === null) {
        note('confirmed factory-default', false, 'could not read identity, addresses and users');
        return {
          ok: false, steps,
          error: "Couldn't read the device's identity, addresses and users to confirm it is factory-default. Nothing was changed.",
        };
      }
      const assessment = assessFactoryState({ identity: identity.name, addresses, users });

      // Authoritative, force or not: force only overrides the guess made
      // from neighbour data before connecting.
      if (!assessment.isFactory) {
        note('confirmed factory-default', false, assessment.warnings.join('; '));
        return {
          ok: false,
          steps,
          error:
            'This device does not look factory-default, so it was not modified: ' +
            assessment.warnings.join('; ') +
            '. Add it normally with its credentials — adoption would overwrite configuration it is already using.',
        };
      }
      note('confirmed factory-default', true, assessment.signals.join(', ') || undefined);

      // Conflict check, from the jump host's own view of the segment. This is
      // the check whose absence would have let the flow assign an address that
      // was already answering — both halves are needed, see judgeConflict.
      if (req.plan.mode === 'static') {
        const conflict = await this.checkAddressFree(client, req.plan.address);
        if (!conflict.free) {
          note(`checked ${req.plan.address} is free`, false, conflict.reason);
          return {
            ok: false, steps,
            error: `${req.plan.address} is not free: ${conflict.reason}. Nothing was changed.`,
          };
        }
        note(`checked ${req.plan.address} is free`, true, 'no ARP entry, no ping reply');
      }

      for (const op of buildPlanOps({ plan: req.plan, identity: req.identity })) {
        const r = await rest(op);
        note(op.describe, r.ok, r.error);
        if (!r.ok) return { ok: false, steps, error: `Failed to ${op.describe}: ${r.error}` };
        await sleep(2000);
      }

      if (req.plan.mode === 'dhcp') {
        // With DHCP the manager does not know where the device landed, so the
        // lease has to be read back before it can be registered. Binding is not
        // instant; a few polls beat one optimistic read.
        for (let attempt = 0; attempt < 6 && !learnedIp; attempt++) {
          await sleep(3000);
          learnedIp = leasedAddress((await this.readMany(rest, 'ip/dhcp-client')) ?? []);
        }
        if (!learnedIp) {
          return {
            ok: false, steps,
            error: `DHCP client added on ${planInterface(req.plan)} but no lease arrived. ` +
                   'Check that a DHCP server serves that segment.',
          };
        }
        note('received DHCP lease', true, learnedIp);
      }
    } catch (err) {
      return { ok: false, steps, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Runs on every path, including the early returns above.
      client?.disconnect();
      if (temp) {
        const removed = await this.removeTempAddress(jump, temp);
        note('removed temporary address from jump host', removed.ok, removed.detail);
      }
    }

    // From here the manager talks to the device directly; the jump host is done.
    const ip = req.plan.mode === 'static' ? stripPrefix(req.plan.address) : (learnedIp as string);
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
        device_type: deviceType ?? 'router',
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

  /**
   * Is this address free, as far as the jump host can tell?
   *
   * ARP and ping, because neither settles it alone: on the reference network
   * 192.168.0.64 replied to ping while absent from the ARP cache. A failure to
   * check is reported as "not free" rather than "free" — an unusable address is
   * an inconvenience, a duplicated one is an outage.
   */
  private async checkAddressFree(
    client: RouterOSClient, address: string, iface?: string
  ): Promise<{ free: boolean; reason?: string }> {
    try {
      // Ping first, then read ARP (outside review C9): the ping is what makes
      // a quiet host resolve, so ARP read before it misses that host.
      const ping = await client.execute('/ping', { address: stripPrefix(address), count: '3' }, [], { timeoutMs: 20000 });
      const replies = Number((ping[ping.length - 1] || {}).received || 0);
      const arp = await client.execute('/ip/arp/print', { detail: '' });
      let arpResolved = arp.some(
        (a) => stripPrefix(a.address || '') === stripPrefix(address) && arpRowResolved(a)
      );
      if (iface && !arpResolved) {
        // An address outside the jump host's own subnets isn't reachable by
        // ICMP or in its ARP table; an ARP request sent out the interface
        // still gets an answer from a host holding it.
        const arping = await client.execute('/ping', {
          address: stripPrefix(address), 'arp-ping': 'yes', interface: iface, count: '2',
        }, [], { timeoutMs: 15000 });
        arpResolved = Number((arping[arping.length - 1] || {}).received || 0) > 0;
      }
      return judgeConflict({ arpResolved, pingReplies: replies });
    } catch (e) {
      return {
        free: false,
        reason: `could not verify the address is free (${e instanceof Error ? e.message : String(e)})`,
      };
    }
  }

  /**
   * Remove the temporary address from the jump host, found by its address and
   * comment on a fresh connection, so it goes even when the add's reply was
   * lost or the adoption connection died. If this fails too, the comment lets
   * cleanupOrphans() find it.
   */
  private async removeTempAddress(jump: DeviceRow, temp: string): Promise<{ ok: boolean; detail?: string }> {
    let c: RouterOSClient | null = null;
    try {
      c = await this.connect(jump);
      const rows = (await c.execute('/ip/address/print', { detail: '' }))
        .filter((a) => stripPrefix(a.address || '') === stripPrefix(temp) && (a.comment || '').includes(TEMP_COMMENT));
      for (const r of rows) await c.execute('/ip/address/remove', { '.id': r['.id'] });
      return { ok: true, detail: rows.length ? undefined : 'not present' };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      c?.disconnect();
    }
  }

  private parse(data: string | undefined): Record<string, string> | null {
    if (!data) return null;
    try { return JSON.parse(data) as Record<string, string>; } catch { return null; }
  }

  /** Read a single-object REST menu (`system/identity`), or null if unreadable. */
  private async readOne(
    rest: (op: RestOp) => Promise<{ ok: boolean; data?: string }>,
    path: string
  ): Promise<Record<string, string> | null> {
    const r = await rest({ method: 'get', path, describe: `read ${path}` });
    if (!r.ok || !r.data) return null;
    try { return JSON.parse(r.data) as Record<string, string>; } catch { return null; }
  }

  /** Read a list REST menu (`ip/address`). Null when unreadable, never [] (C9). */
  private async readMany(
    rest: (op: RestOp) => Promise<{ ok: boolean; data?: string }>,
    path: string
  ): Promise<Record<string, string>[] | null> {
    const r = await rest({ method: 'get', path, describe: `read ${path}` });
    if (!r.ok || !r.data) return null;
    try {
      const parsed = JSON.parse(r.data);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
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
