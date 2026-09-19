/**
 * Adopting a factory-default MikroTik device.
 *
 * A brand-new MikroTik is visible the moment it is plugged in — it announces
 * itself over MNDP/CDP and every managed neighbour reports it — but it cannot be
 * adopted, because its factory configuration puts it on `192.168.88.1/24` with
 * no DHCP client and no default route. It is on the wire but not on the network,
 * so the manager has no path to it and the only way in was Winbox by MAC.
 *
 * What makes automatic adoption possible is that the manager does not need a
 * path of its own: a *managed* device on the same broadcast domain already has
 * one. Established against a real CRS310-8G+2S+ on RouterOS 7.21.4:
 *
 *   - the API service is already enabled on a factory device, so nothing needs
 *     turning on — the only true blocker is reachability
 *   - a managed neighbour given a temporary address in 192.168.88.0/24 can reach
 *     the target immediately (ping 399µs)
 *   - `/tool/fetch` on that neighbour can drive the target's REST API, which
 *     gives full read *and* write access without an interactive session
 *
 * So adoption is: borrow a neighbour, give the target an address on the real
 * network, hand it back. This module is the decision-making half — which
 * neighbour to borrow, which addresses are safe to use, and what to do — kept
 * pure so it can be tested without touching hardware.
 *
 * Two findings that shaped the safety rules, both observed rather than assumed:
 *
 * **Credentials.** Modern MikroTik units ship with a unique password printed on
 * the device, not a blank one. Assuming blank produced a 401 that looked exactly
 * like a broken auth mechanism and cost real time chasing it. The password must
 * come from the operator; there is nothing to guess.
 *
 * **Address checks.** Probing for a free address, `192.168.0.64` answered ping
 * while being absent from the ARP table. Either check alone would have handed a
 * duplicate address to a switch, so both are required.
 */

export interface NeighborRow {
  neighbor_mac: string | null;
  neighbor_address: string | null;
  neighbor_identity: string | null;
  neighbor_platform: string | null;
  from_device_id: number;
  from_interface: string | null;
  discovered_at?: string | Date | null;
}

export interface AdoptionCandidate {
  mac: string;
  address: string;
  identity: string | null;
  /** Managed device ids that can see it — any of them can act as jump host. */
  seenBy: number[];
  /** True when the address is the MikroTik factory default. */
  factoryDefault: boolean;
}

/** RouterOS ships every unconfigured device on this address. */
export const FACTORY_ADDRESS = '192.168.88.1';
/** Comment written on anything temporary, so orphans are findable. */
export const TEMP_COMMENT = 'mtm-adopt-temporary';
/** Comment written on configuration adoption adds, so it can be identified later. */
export const ADOPTED_COMMENT = 'mtm-adopted';

/**
 * Group raw neighbour rows into adoptable candidates.
 *
 * A device is a candidate when it is a MikroTik we do not manage and it reports
 * an address we could reach if we shared its subnet. The same device is normally
 * reported by several managed neighbours — on the reference fleet a single new
 * switch appeared four times — so rows are collapsed by MAC and every reporter
 * is kept, because each one is a potential jump host.
 */
export function collectCandidates(rows: NeighborRow[]): AdoptionCandidate[] {
  const byMac = new Map<string, AdoptionCandidate>();

  for (const r of rows) {
    const mac = (r.neighbor_mac || '').toUpperCase().trim();
    const address = (r.neighbor_address || '').trim();
    if (!mac || !address) continue;
    // Only MikroTik. LLDP happily reports switches from other vendors, and none
    // of this applies to them.
    if (!/mikrotik/i.test(r.neighbor_platform || '')) continue;
    if (!isIpv4(address)) continue;

    const existing = byMac.get(mac);
    if (existing) {
      if (!existing.seenBy.includes(r.from_device_id)) existing.seenBy.push(r.from_device_id);
      continue;
    }
    byMac.set(mac, {
      mac,
      address,
      identity: r.neighbor_identity || null,
      seenBy: [r.from_device_id],
      factoryDefault: address === FACTORY_ADDRESS,
    });
  }

  return [...byMac.values()];
}

/**
 * Whether the manager could already reach this address directly.
 *
 * If it could, adoption does not need a jump host at all and the normal "add
 * device" path applies. Reachability is decided by whether the target shares a
 * subnet with a device we already manage, which is the best proxy available
 * without attempting a connection.
 */
export function needsJumpHost(targetAddress: string, managedAddresses: string[], prefix = 24): boolean {
  return !managedAddresses.some((m) => sameSubnet(targetAddress, m, prefix));
}

/**
 * Choose a temporary address for the jump host inside the target's subnet.
 *
 * Must avoid the target itself and anything the jump host already holds. Counts
 * down from .250 because the low end of a factory subnet is where a DHCP pool
 * would sit if one were ever enabled.
 */
export function pickTempAddress(
  targetAddress: string,
  taken: string[],
  prefix = 24
): string | null {
  if (!isIpv4(targetAddress)) return null;
  const used = new Set([targetAddress, ...taken.map(stripPrefix)]);
  const base = targetAddress.split('.').slice(0, 3).join('.');

  for (let host = 250; host >= 200; host--) {
    const candidate = `${base}.${host}`;
    if (!used.has(candidate)) return `${candidate}/${prefix}`;
  }
  return null;
}

export interface AddressVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Validate the permanent address an operator chose for the device.
 *
 * Deliberately refuses an address outside the jump host's own subnet. Getting
 * this wrong strands the device: it would take the address, stop answering on
 * the factory one, and be unreachable from both networks at once — recoverable
 * only by physically resetting it.
 */
export function validateTargetAddress(
  address: string,
  managerSubnetPeer: string,
  prefix = 24,
  knownInUse: string[] = []
): AddressVerdict {
  const bare = stripPrefix(address);
  if (!isIpv4(bare)) return { ok: false, reason: `${address} is not a valid IPv4 address` };

  const host = Number(bare.split('.')[3]);
  if (host === 0) return { ok: false, reason: 'that is a network address, not a host address' };
  if (prefix === 24 && host === 255) return { ok: false, reason: 'that is the broadcast address' };

  if (!sameSubnet(bare, managerSubnetPeer, prefix)) {
    return {
      ok: false,
      reason: `${bare} is not in the same subnet as ${managerSubnetPeer}, so the manager would not be able to reach it`,
    };
  }
  if (knownInUse.map(stripPrefix).includes(bare)) {
    return { ok: false, reason: `${bare} is already in use` };
  }
  return { ok: true };
}

export interface RestOp {
  method: 'get' | 'put' | 'post' | 'patch' | 'delete';
  path: string;
  body?: Record<string, string>;
  /** Human wording for the progress log. */
  describe: string;
}

/**
 * The ordered REST calls that turn a factory device into a reachable one.
 *
 * Additive first. The factory address is left in place while the new one is
 * proven, so a failure halfway leaves the device exactly as reachable as it was
 * rather than stranded. Removing the factory address is a separate, later step
 * performed over the *new* path once that path is known to work.
 *
 * The default route matters as much as the address: the manager here sits on a
 * different subnet from the switches, so an address alone would let the device
 * receive traffic and be unable to reply.
 */
export function buildAdoptionOps(opts: {
  targetAddress: string;
  gateway: string;
  bridgeInterface?: string;
  identity?: string;
}): RestOp[] {
  const iface = opts.bridgeInterface || 'bridge';
  const ops: RestOp[] = [
    {
      method: 'put',
      path: 'ip/address',
      body: { address: opts.targetAddress, interface: iface, comment: ADOPTED_COMMENT },
      describe: `add ${opts.targetAddress} on ${iface}`,
    },
    {
      method: 'put',
      path: 'ip/route',
      body: { 'dst-address': '0.0.0.0/0', gateway: opts.gateway, comment: ADOPTED_COMMENT },
      describe: `add default route via ${opts.gateway}`,
    },
  ];
  if (opts.identity?.trim()) {
    ops.push({
      method: 'post',
      path: 'system/identity/set',
      body: { name: opts.identity.trim() },
      describe: `set identity to ${opts.identity.trim()}`,
    });
  }
  return ops;
}

/** `Authorization` and `Content-Type`, in the single comma-joined string fetch expects. */
export function fetchAuthHeader(username: string, password: string): string {
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  return `Authorization: Basic ${basic},Content-Type: application/json`;
}

// ── address helpers ────────────────────────────────────────────────────────

export function isIpv4(s: string): boolean {
  const parts = stripPrefix(s).split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

export function stripPrefix(s: string): string {
  return (s || '').split('/')[0].trim();
}

export function sameSubnet(a: string, b: string, prefix = 24): boolean {
  const x = stripPrefix(a);
  const y = stripPrefix(b);
  if (!isIpv4(x) || !isIpv4(y)) return false;
  const mask = prefix >= 32 ? -1 : ~((1 << (32 - prefix)) - 1);
  return (ipToInt(x) & mask) === (ipToInt(y) & mask);
}

export function ipToInt(ip: string): number {
  return stripPrefix(ip).split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

// ── Telling a new device from an established one ───────────────────────────

/**
 * Two quite different situations produce a discovered MikroTik, and treating
 * them the same is how this feature could do real damage.
 *
 * **An established device.** The manager has just been pointed at a network
 * full of switches that are already configured and working. They need
 * credentials and nothing else; the old "add to manager" flow is exactly right.
 * Writing an address or an identity to one of these would be modifying
 * production configuration nobody asked us to touch.
 *
 * **A factory device.** Straight out of the box, on 192.168.88.1, unreachable.
 * This is the one that needs adopting.
 *
 * Reachability alone cannot tell them apart, which was the flaw in the first
 * version: an established switch on a subnet we do not route to is unreachable
 * *and* fully configured, and would have been offered for adoption. So the test
 * is what the device looks like, not whether we can get to it.
 */

export type AdoptionMode =
  /** Configure it first, then register. Factory-default devices only. */
  | 'adopt'
  /** Register with credentials, changing nothing. Everything else. */
  | 'add';

export interface ModeRecommendation {
  mode: AdoptionMode;
  /** How sure we are, which decides whether the UI argues or just defaults. */
  confidence: 'high' | 'low';
  reasons: string[];
}

/** RouterOS's out-of-the-box system identity. */
export const FACTORY_IDENTITY = 'MikroTik';

/**
 * Which flow to offer, decided from neighbour data alone.
 *
 * Only two signals are visible before connecting, and both are strong: the
 * factory address and the factory identity. A device showing both is new. A
 * device showing neither is somebody's working switch, however unreachable it
 * happens to be from here.
 */
export function recommendMode(candidate: {
  address: string;
  identity: string | null;
  reachableDirectly?: boolean;
}): ModeRecommendation {
  const onFactoryAddress = candidate.address === FACTORY_ADDRESS;
  const hasFactoryIdentity = (candidate.identity || '').trim() === FACTORY_IDENTITY;
  const reasons: string[] = [];

  if (onFactoryAddress) reasons.push(`still on the factory address ${FACTORY_ADDRESS}`);
  if (hasFactoryIdentity) reasons.push(`identity is still "${FACTORY_IDENTITY}"`);

  if (onFactoryAddress && hasFactoryIdentity) {
    return { mode: 'adopt', confidence: 'high', reasons };
  }

  // One signal without the other. Could be a factory device someone has half
  // configured, or a real device that happens to be unnamed. Offer adoption but
  // say it is a guess, so the choice lands with the operator.
  if (onFactoryAddress || hasFactoryIdentity) {
    reasons.push('but not both of the usual factory markers — worth confirming');
    return { mode: 'adopt', confidence: 'low', reasons };
  }

  reasons.push('has its own address and identity, so it is already configured');
  if (candidate.reachableDirectly === false) {
    // The case that matters: configured, but we have no route. Not an adoption
    // problem, and adopting it would rewrite a working device.
    reasons.push('not reachable from here — it needs a route or a credential, not adoption');
  }
  return { mode: 'add', confidence: 'high', reasons };
}

export interface FactoryAssessment {
  isFactory: boolean;
  signals: string[];
  warnings: string[];
}

/**
 * Confirm a device really is unconfigured, after authenticating and before
 * writing anything.
 *
 * The pre-connection guess uses the two fields neighbour discovery exposes.
 * Once connected there is far more to go on, and this is the last point at
 * which we can decline harmlessly. It exists so that a wrong choice in the UI
 * cannot quietly reconfigure production equipment.
 *
 * Fixtures for the thresholds come from the reference CRS310 as delivered: a
 * single address carrying RouterOS's own `defconf` comment, one user, and the
 * default identity.
 */
export function assessFactoryState(state: {
  identity?: string | null;
  addresses?: { address?: string; comment?: string }[];
  users?: { name?: string }[];
}): FactoryAssessment {
  const signals: string[] = [];
  const warnings: string[] = [];

  const identity = (state.identity || '').trim();
  if (identity === FACTORY_IDENTITY) signals.push('default identity');
  else if (identity) warnings.push(`identity is "${identity}", not the factory default`);

  const addresses = state.addresses ?? [];
  const defconf = addresses.filter((a) => (a.comment || '').includes('defconf'));
  if (defconf.length > 0) signals.push('address carries RouterOS defconf comment');

  const nonFactory = addresses.filter(
    (a) => stripPrefix(a.address || '') !== FACTORY_ADDRESS
  );
  if (nonFactory.length > 0) {
    warnings.push(
      `has ${nonFactory.length} address(es) beyond the factory one: ` +
      nonFactory.map((a) => a.address).join(', ')
    );
  }

  const users = state.users ?? [];
  if (users.length === 1) signals.push('single default user');
  else if (users.length > 1) warnings.push(`${users.length} user accounts are configured`);

  // Any warning is disqualifying. This is deliberately strict: refusing to adopt
  // a genuinely new device costs one override, while adopting a live one
  // rewrites its addressing.
  return { isFactory: warnings.length === 0 && signals.length > 0, signals, warnings };
}
