/**
 * Topology graph construction.
 *
 * Extracted from the route handler so the graph rules can be exercised against
 * fixtures — the logic is subtle, order-dependent, and its failure mode is a
 * plausible-looking map rather than an error.
 *
 * ## Identifier uniqueness, and why it matters
 *
 * Neighbour discovery gives us four ways to name the far end of a link: a resolved
 * managed device id, a MAC address, an IP address, and a system identity. Only the
 * first two are unique across a fleet. **IP addresses and identities are unique only
 * within a broadcast domain.**
 *
 * Treating them as globally unique fabricates links between physically separate
 * networks: an installation with several disconnected segments that each reuse
 * `10.2.0.0/24` and each name their management VLAN the same thing will see devices
 * in segment A joined to devices in segment C, because both segments contain a
 * `10.2.0.1` (github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/90).
 *
 * The defence is to detect identifiers that demonstrably are not unique and refuse
 * to merge on them, rather than to invent a notion of "segment" the data cannot
 * support (the reporting installation uses the same VLAN name everywhere, so even
 * the VLAN is not a discriminator). An ambiguous identifier is scoped to the device
 * that reported it, so it still deduplicates that device's own view while never
 * joining two devices together.
 */

export interface TopoDevice {
  id: number;
  name: string;
  ip_address: string;
  ip_addresses_jsonb?: unknown;
  [key: string]: unknown;
}

export interface LinkRow {
  id: number;
  from_device_id: number | null;
  from_interface: string | null;
  to_interface: string | null;
  to_device_id: number | null;
  neighbor_address: string | null;
  neighbor_identity: string | null;
  neighbor_platform: string | null;
  neighbor_mac: string | null;
  stp_role: string | null;
  stp_state: string | null;
  bridge_name: string | null;
  neighbor_caps: string | null;
  link_type: string | null;
  discovered_by: string | null;
  from_device_name: string | null;
  to_device_name: string | null;
}

export interface ManualLinkRow {
  id: number;
  from_device_id: number;
  to_device_id: number;
  label: string | null;
  from_name: string;
  to_name: string;
}

export interface ExternalNode {
  id: string;
  name: string;
  address: string;
  platform: string;
  mac: string;
  caps: string;
}

export interface SegConn { src: string; dst: string; port: string; }

export interface TopologyGraph {
  links: LinkRow[];
  externalNodes: ExternalNode[];
  segConns: SegConn[];
  /**
   * Identifiers found on more than one device or neighbour. Surfaced so the cause
   * of a sparser-than-expected map is inspectable rather than mysterious.
   */
  ambiguous: { addresses: string[]; identities: string[] };
}

const PROTO_RANK: Record<string, number> = { lldp: 0, cdp: 1, mndp: 2 };
const protoRank = (p: string | null) => PROTO_RANK[p ?? ''] ?? 3;

const stripCidr = (a: string) => { const i = a.indexOf('/'); return i === -1 ? a : a.slice(0, i); };
const normIp = (a: string) => stripCidr(a.trim()).toLowerCase();
const normId = (s: string) => s.trim().toLowerCase();

/** Every address a managed device answers on, normalised. */
function deviceAddresses(d: TopoDevice): string[] {
  const out: string[] = [];
  if (d.ip_address) out.push(normIp(d.ip_address));
  if (Array.isArray(d.ip_addresses_jsonb)) {
    for (const entry of d.ip_addresses_jsonb) {
      const raw = typeof entry === 'object' && entry && 'address' in entry
        ? String((entry as { address?: string }).address || '') : '';
      const k = normIp(raw);
      if (k) out.push(k);
    }
  }
  return out.filter(Boolean);
}

/**
 * Identify addresses and identities that cannot be trusted to name one thing.
 *
 * This drives two decisions only: whether an address may resolve to a managed
 * device (Step 2), and whether it may mark a neighbour as already covered by LLDP
 * (Step 3). Both ask the same question — does this address identify exactly one
 * device across the whole fleet?
 *
 * Two signals answer it:
 *  - more than one managed device claims the address
 *  - sightings of the address disagree about the neighbour's identity, which means
 *    at least two different devices answer to it
 *
 * Deliberately NOT a signal: seeing the address with more than one MAC. A switch
 * assigns a MAC per port, so a device with two uplinks is legitimately reported as
 * `F4:1E:57:51:74:0E` from one neighbour and `…:0F` from another. Treating that as a
 * conflict would refuse to resolve ordinary multi-port hardware — observed on a real
 * fleet, where all three sightings agreed on the identity `2GT-NW-100G`.
 */
export function findAmbiguousIdentifiers(
  devices: TopoDevice[],
  links: LinkRow[]
): { addresses: Set<string>; identities: Set<string> } {
  const addrDevices = new Map<string, Set<number>>();
  const addrIdentities = new Map<string, Set<string>>();
  const identDevices = new Map<string, Set<number>>();

  const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => {
    const s = m.get(k) ?? new Set<V>();
    s.add(v);
    m.set(k, s);
  };

  for (const d of devices) {
    for (const a of deviceAddresses(d)) add(addrDevices, a, d.id);
    if (d.name) add(identDevices, normId(d.name), d.id);
  }

  for (const l of links) {
    if (!l.neighbor_address || !l.neighbor_identity) continue;
    add(addrIdentities, normIp(l.neighbor_address), normId(l.neighbor_identity));
  }

  const addresses = new Set<string>();
  for (const [a, s] of addrDevices) if (s.size > 1) addresses.add(a);
  for (const [a, s] of addrIdentities) if (s.size > 1) addresses.add(a);

  const identities = new Set<string>();
  for (const [i, s] of identDevices) if (s.size > 1) identities.add(i);

  return { addresses, identities };
}

/**
 * A stable name for the far end of a link.
 *
 * A resolved device id or a MAC identifies hardware, and hardware is unique — those
 * keys are global. An address or a bare identity is not proof of identity at all, so
 * those keys are always scoped to the device that reported them. Two devices that
 * each see "10.2.0.1" therefore describe two neighbours unless a MAC says otherwise.
 *
 * This costs nothing in practice: RouterOS neighbour discovery reports a MAC for
 * MNDP and CDP alike, so genuinely shared segments still merge on the MAC. Where a
 * MAC really is missing we degrade to one node per reporting device — visibly
 * duplicated, which an operator can reason about, rather than a fabricated adjacency
 * between networks that cannot reach each other.
 */
function makeNeighborKey() {
  return (l: LinkRow): string | null => {
    if (l.to_device_id) return `d:${l.to_device_id}`;
    if (l.neighbor_mac) return `m:${l.neighbor_mac.toLowerCase()}`;
    const scope = `@${l.from_device_id ?? '?'}`;
    if (l.neighbor_address) return `a:${normIp(l.neighbor_address)}${scope}`;
    if (l.neighbor_identity) return `i:${normId(l.neighbor_identity)}${scope}`;
    return null;
  };
}

export function buildTopology(
  devices: TopoDevice[],
  allLinks: LinkRow[],
  manualLinks: ManualLinkRow[],
  deviceMacs: { device_id: number; mac_address: string }[] = []
): TopologyGraph {
  const amb = findAmbiguousIdentifiers(devices, allLinks);
  const neighborKey = makeNeighborKey();

  // ── Step 0: Resolve neighbours by MAC ──────────────────────────────────────
  //
  // Runs before everything else because a MAC identifies hardware and is unique
  // fleet-wide, which no other neighbour field is. It also covers the case address
  // matching cannot: a trunk port carries no IP, so LLDP across one reports a MAC
  // and an identity but no address. Those links stayed unresolved and rendered as
  // external nodes duplicating devices already on the map
  // (github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/95).
  const macToDevice = new Map<string, { id: number; name: string }>();
  const deviceNames = new Map(devices.map((d) => [d.id, d.name]));
  for (const row of deviceMacs) {
    if (!row.mac_address) continue;
    const key = row.mac_address.toUpperCase();
    if (!macToDevice.has(key)) {
      macToDevice.set(key, { id: row.device_id, name: deviceNames.get(row.device_id) ?? '' });
    }
  }

  for (const link of allLinks) {
    if (link.to_device_id || !link.neighbor_mac) continue;
    const hit = macToDevice.get(link.neighbor_mac.toUpperCase());
    if (hit && hit.id !== link.from_device_id) {
      link.to_device_id = hit.id;
      link.to_device_name = hit.name || link.to_device_name;
    }
  }

  // ── Step 1: Per-(device, neighbor) best-protocol dedup ─────────────────────
  const bestByPair = new Map<string, LinkRow>();
  for (const link of allLinks) {
    if (!link.from_device_id) continue;
    const nk = neighborKey(link);
    if (!nk) continue;
    const key = `${link.from_device_id}::${nk}`;
    const existing = bestByPair.get(key);
    if (!existing || protoRank(link.link_type) < protoRank(existing.link_type)) {
      bestByPair.set(key, link);
    }
  }
  let links = Array.from(bestByPair.values());

  // ── Step 2: Resolve neighbor IP → managed device ───────────────────────────
  // Only unambiguous addresses may resolve. An address living on two devices tells
  // us nothing about which one a neighbour actually is, and guessing produces a
  // link between networks that cannot reach each other.
  const ipToDevice = new Map<string, { id: number; name: string }>();
  for (const d of devices) {
    for (const a of deviceAddresses(d)) {
      if (amb.addresses.has(a)) continue;
      if (!ipToDevice.has(a)) ipToDevice.set(a, { id: d.id, name: d.name });
    }
  }

  for (const link of links) {
    if (link.to_device_id) continue;
    const na = link.neighbor_address?.trim();
    if (!na || na.includes('%')) continue;
    const hit = ipToDevice.get(normIp(na));
    if (hit && hit.id !== link.from_device_id) {
      link.to_device_id = hit.id;
      link.to_device_name = hit.name;
    }
  }

  // ── Step 3: Build "LLDP-covered" neighbor set ───────────────────────────────
  // Suppress CDP/MNDP links to a neighbour LLDP already describes precisely. Only
  // globally unique identifiers may suppress: an ambiguous address would silence a
  // real link in another segment that merely reuses the same numbering.
  const lldpCoveredDeviceIds = new Set<number>();
  const lldpCoveredMacs = new Set<string>();
  const lldpCoveredAddresses = new Set<string>();

  for (const link of links) {
    if (link.link_type !== 'lldp') continue;
    if (link.to_device_id) lldpCoveredDeviceIds.add(link.to_device_id);
    if (link.neighbor_mac) lldpCoveredMacs.add(link.neighbor_mac.toLowerCase());
    if (link.neighbor_address) {
      const a = normIp(link.neighbor_address);
      if (!amb.addresses.has(a)) lldpCoveredAddresses.add(a);
    }
  }

  const isLldpCovered = (link: LinkRow): boolean => {
    if (link.to_device_id && lldpCoveredDeviceIds.has(link.to_device_id)) return true;
    if (link.neighbor_mac && lldpCoveredMacs.has(link.neighbor_mac.toLowerCase())) return true;
    if (link.neighbor_address && lldpCoveredAddresses.has(normIp(link.neighbor_address))) return true;
    return false;
  };

  links = links.filter((l) => l.link_type === 'lldp' || !isLldpCovered(l));

  // ── Step 4: Merge bidirectional LLDP pairs ─────────────────────────────────
  const canonicalLldp: LinkRow[] = [];
  const mergedPairs = new Set<string>();

  for (const link of links) {
    if (link.link_type !== 'lldp' || !link.to_device_id) {
      canonicalLldp.push(link);
      continue;
    }
    const lo = Math.min(link.from_device_id!, link.to_device_id);
    const hi = Math.max(link.from_device_id!, link.to_device_id);
    const pairKey = `${lo}:${hi}`;

    if (mergedPairs.has(pairKey)) continue;
    mergedPairs.add(pairKey);

    const forward = link.from_device_id === lo ? link : links.find(
      (r) => r.link_type === 'lldp' && r.from_device_id === lo && r.to_device_id === hi
    );
    const reverse = links.find(
      (r) => r.link_type === 'lldp' && r.from_device_id === hi && r.to_device_id === lo
    );

    const canonical = forward ?? link;
    if (!canonical.to_interface && reverse?.from_interface) canonical.to_interface = reverse.from_interface;
    if (!canonical.from_interface && reverse?.to_interface) canonical.from_interface = reverse.to_interface;

    canonicalLldp.push(canonical);
  }

  links = canonicalLldp;

  // ── Step 5: Build external node map ────────────────────────────────────────
  // Keyed by the same neighbour key used everywhere else, so two unmanaged devices
  // that merely share an address in disconnected segments stay two nodes.
  const externalMap = new Map<string, ExternalNode>();
  for (const link of links) {
    if (link.to_device_id) continue;
    const key = neighborKey(link);
    if (!key) continue;
    if (!externalMap.has(key)) {
      externalMap.set(key, {
        id: `ext-${key.replace(/[^a-z0-9]/gi, '')}`,
        name: link.neighbor_identity || link.neighbor_address || 'Unknown',
        address: link.neighbor_address || '',
        platform: link.neighbor_platform || '',
        mac: link.neighbor_mac || '',
        caps: link.neighbor_caps || '',
      });
    }
  }

  // ── Step 6: Shared-segment detection ───────────────────────────────────────
  const lldpLinks = links.filter((l) => l.link_type === 'lldp');
  const nonLldpLinks = links.filter((l) => l.link_type !== 'lldp' && !!l.from_device_id);

  const portGroupMap = new Map<string, LinkRow[]>();
  for (const link of nonLldpLinks) {
    const pk = `${link.from_device_id}::${link.from_interface ?? ''}`;
    if (!portGroupMap.has(pk)) portGroupMap.set(pk, []);
    portGroupMap.get(pk)!.push(link);
  }

  const sharedPortKeys = [...portGroupMap.keys()].filter((pk) => portGroupMap.get(pk)!.length >= 2);
  const soloNonLldp = [...portGroupMap.values()].filter((g) => g.length < 2).flat();

  // Union-find to merge port groups sharing a common neighbour. Merging asserts two
  // ports face the same physical segment, so it may only rest on an identifier that
  // is unique fleet-wide — a device-scoped key can never match another device's.
  const ufParent = new Map<string, string>(sharedPortKeys.map((k) => [k, k]));
  const ufFind = (k: string): string => {
    if (ufParent.get(k) !== k) ufParent.set(k, ufFind(ufParent.get(k)!));
    return ufParent.get(k)!;
  };
  const ufUnion = (a: string, b: string) => ufParent.set(ufFind(a), ufFind(b));

  const pkNeighborSets = new Map<string, Set<string>>();
  for (const pk of sharedPortKeys) {
    pkNeighborSets.set(
      pk,
      new Set(portGroupMap.get(pk)!.map(neighborKey).filter((k): k is string => k !== null))
    );
  }
  for (let i = 0; i < sharedPortKeys.length; i++) {
    for (let j = i + 1; j < sharedPortKeys.length; j++) {
      const setA = pkNeighborSets.get(sharedPortKeys[i])!;
      for (const n of pkNeighborSets.get(sharedPortKeys[j])!) {
        if (setA.has(n)) { ufUnion(sharedPortKeys[i], sharedPortKeys[j]); break; }
      }
    }
  }

  const segGroups = new Map<string, string[]>();
  for (const pk of sharedPortKeys) {
    const root = ufFind(pk);
    if (!segGroups.has(root)) segGroups.set(root, []);
    segGroups.get(root)!.push(pk);
  }

  const segNodes: ExternalNode[] = [];
  const segConns: SegConn[] = [];

  for (const [root, pks] of segGroups) {
    const segId = `seg-${root.replace(/[^a-z0-9]/gi, '')}`;
    const srcDevPorts = new Map<string, string>();
    const allDevIds = new Set<string>();
    const extKeys = new Set<string>();

    for (const pk of pks) {
      const colonIdx = pk.indexOf('::');
      const devId = pk.slice(0, colonIdx);
      const port = pk.slice(colonIdx + 2);
      srcDevPorts.set(devId, port);
      allDevIds.add(devId);
      for (const link of portGroupMap.get(pk)!) {
        if (link.to_device_id) allDevIds.add(String(link.to_device_id));
        else {
          const k = neighborKey(link);
          if (k) extKeys.add(k);
        }
      }
    }

    segNodes.push({
      id: segId,
      name: 'Shared Segment',
      address: '',
      platform: `${allDevIds.size} devices`,
      mac: '',
      caps: 'segment',
    });

    for (const [devId, port] of srcDevPorts) segConns.push({ src: devId, dst: segId, port });
    // Direct key lookup — Step 5 keys the map by the same function, so no
    // reconstruct-and-compare guesswork.
    for (const k of extKeys) {
      const ext = externalMap.get(k);
      if (ext) segConns.push({ src: ext.id, dst: segId, port: '' });
    }
  }

  // ── Step 7: Manual links as synthetic rows ─────────────────────────────────
  const manualAsLinks: LinkRow[] = manualLinks.map((ml) => ({
    id: -ml.id,
    from_device_id: ml.from_device_id,
    from_interface: ml.label ?? null,
    to_interface: null,
    to_device_id: ml.to_device_id,
    neighbor_address: null,
    neighbor_identity: null,
    neighbor_platform: null,
    neighbor_mac: null,
    stp_role: null,
    stp_state: null,
    bridge_name: null,
    neighbor_caps: null,
    link_type: 'manual',
    discovered_by: null,
    from_device_name: ml.from_name,
    to_device_name: ml.to_name,
  }));

  return {
    links: [...lldpLinks, ...soloNonLldp, ...manualAsLinks],
    externalNodes: [...externalMap.values(), ...segNodes],
    segConns,
    ambiguous: { addresses: [...amb.addresses], identities: [...amb.identities] },
  };
}
