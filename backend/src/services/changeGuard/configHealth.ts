/**
 * Config Health — a standing audit for configurations RouterOS accepts but that
 * do not work.
 *
 * RouterOS applies each command immediately and independently, with no transaction
 * and no cross-object validation. Contradictory state is accepted and simply
 * misbehaves: an address on a bridge slave port is silently unreachable, a VLAN
 * interface on a slave port takes the device off the network, a PVID next to
 * `frame-type=admit-only-vlan-tagged` does nothing at all. MikroTik documents these
 * on its Layer2 misconfiguration page — as prose. This module encodes them.
 *
 * Change Guard answers "will this change break reachability?". This answers the
 * other half: "what is already wrong, and has been for a while?" — including
 * configurations that work today only because a dynamic entry happens to exist.
 *
 * `auditConfig` is pure over a snapshot so every rule is testable against fixtures;
 * persistence lives in `runConfigHealth`.
 */
import { query } from '../../config/database';
import { expandVlanIds, rosList } from '../../utils/vlan';
import {
  captureSnapshot,
  resolveManagementPath,
  vlanMembership,
  type DeviceSnapshot,
  type RosRow,
} from './pathModel';
import type { GuardDevice } from './ChangeGuard';

export type FindingSeverity = 'critical' | 'warning' | 'info';

export interface ConfigFinding {
  /** Stable rule identifier, e.g. 'ip-on-bridge-port'. */
  rule: string;
  /** Identifies this specific problem instance, so it can be tracked over time. */
  fingerprint: string;
  severity: FindingSeverity;
  title: string;
  /** What is wrong and what it actually does to the network. */
  detail: string;
  /** The concrete fix. */
  remediation: string;
  docUrl: string;
  /** Device objects involved — interface names, VLAN ids, addresses. */
  objects: string[];
}

const L2_DOC = 'https://help.mikrotik.com/docs/spaces/ROS/pages/19136718/Layer2+misconfiguration';
const VLAN_TABLE_DOC = 'https://help.mikrotik.com/docs/spaces/ROS/pages/28606465/Bridge+VLAN+Table';
const BRIDGING_DOC = 'https://help.mikrotik.com/docs/spaces/ROS/pages/328068/Bridging+and+Switching';

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';
const stripCidr = (addr: string): string => (addr || '').split('/')[0].trim();

/**
 * Bridge ports that are actually carrying traffic. A disabled or inactive port is
 * not slaved in practice, so configurations that would conflict with it do work —
 * flagging them would be a false positive.
 */
function activeBridgePorts(snap: DeviceSnapshot): Map<string, RosRow> {
  const map = new Map<string, RosRow>();
  for (const p of snap.bridgePorts) {
    const name = p['interface'];
    if (!name) continue;
    if (isTrue(p['disabled']) || isTrue(p['inactive'])) continue;
    map.set(name, p);
  }
  return map;
}

// ─── rules ────────────────────────────────────────────────────────────────────

/**
 * An IP address on a bridge slave port.
 *
 * The naive form of this check is wrong on RouterOS 7, and real hardware proved it:
 * a `defconf` address configured on a slave port is reported with `slave=true` and
 * `actual-interface=<bridge>`, because RouterOS quietly relocates it to the bridge
 * and it works perfectly. Calling that "unreachable" would be a false positive on a
 * very common default configuration.
 *
 * So the severity follows what RouterOS actually did:
 *  - relocated to the bridge  → informational; the address works, but the
 *    configuration names an interface that is not the one serving it
 *  - not relocated            → critical; the port hands frames to the bridge and
 *    nothing terminates the address
 */
function ruleIpOnBridgePort(snap: DeviceSnapshot): ConfigFinding[] {
  const ports = activeBridgePorts(snap);
  const bridgeNames = new Set(snap.bridges.map((b) => b['name']).filter(Boolean));
  const out: ConfigFinding[] = [];

  for (const a of snap.addresses) {
    if (isTrue(a['disabled']) || isTrue(a['invalid'])) continue;
    const configured = a['interface'] || '';
    const actual = a['actual-interface'] || configured;

    // Only interesting when the address was configured on a port that is slaved to
    // a bridge; an address configured directly on the bridge is entirely normal.
    const port = ports.get(configured);
    if (!port || bridgeNames.has(configured)) continue;

    const relocated = actual !== configured && bridgeNames.has(actual);
    if (relocated) {
      out.push({
        rule: 'ip-on-bridge-port',
        fingerprint: `ip-on-bridge-port:${configured}:${a['address']}`,
        severity: 'info',
        title: `${a['address']} is configured on ${configured} but served by ${actual}`,
        detail:
          `${configured} is a member port of bridge ${actual}, so RouterOS moved the address to `
          + `the bridge — it works, but the configuration names a port that is not the one `
          + `answering. Anything reasoning about this address from the config alone, including `
          + `firewall rules scoped to ${configured}, will not match where the traffic really is.`,
        remediation:
          `Move ${a['address']} onto ${actual} directly so the configuration says what is `
          + `actually happening.`,
        docUrl: L2_DOC,
        objects: [configured, actual, a['address']],
      });
      continue;
    }

    out.push({
      rule: 'ip-on-bridge-port',
      fingerprint: `ip-on-bridge-port:${configured}:${a['address']}`,
      severity: 'critical',
      title: `${a['address']} is unreachable — it sits on bridge port ${configured}`,
      detail:
        `${configured} is a member port of bridge ${port['bridge']}, so it forwards every frame `
        + `into the bridge instead of terminating it locally, and RouterOS has not relocated the `
        + `address to the bridge. ${a['address']} is configured but nothing can reach it.`,
      remediation:
        `Move the address onto ${port['bridge']} itself (or onto a VLAN interface on that bridge), `
        + `or remove ${configured} from the bridge if it is meant to be routed.`,
      docUrl: L2_DOC,
      objects: [configured, a['address']],
    });
  }
  return out;
}

/**
 * A VLAN interface whose parent is a bridge slave port. MikroTik's own wording for
 * this case is that the device becomes unreachable: the parent port passes frames to
 * the bridge, so the VLAN interface never sees them.
 */
function ruleVlanIfaceOnBridgePort(snap: DeviceSnapshot): ConfigFinding[] {
  const ports = activeBridgePorts(snap);
  const out: ConfigFinding[] = [];
  for (const v of snap.vlanInterfaces) {
    if (isTrue(v['disabled'])) continue;
    const parent = v['interface'] || '';
    const port = ports.get(parent);
    if (!port) continue;
    out.push({
      rule: 'vlan-iface-on-bridge-port',
      fingerprint: `vlan-iface-on-bridge-port:${v['name']}`,
      severity: 'critical',
      title: `VLAN interface ${v['name']} is built on bridge port ${parent}`,
      detail:
        `${parent} is a member of bridge ${port['bridge']}, so tagged frames are handed to the `
        + `bridge rather than to ${v['name']}. The VLAN interface receives nothing, and anything `
        + `depending on it — including management — is unreachable.`,
      remediation:
        `Create the VLAN interface on bridge ${port['bridge']} instead of on ${parent}, and let the `
        + `bridge VLAN table decide which ports carry VLAN ${v['vlan-id']}.`,
      docUrl: L2_DOC,
      objects: [v['name'], parent],
    });
  }
  return out;
}

/**
 * A VLAN interface added as a bridge port. Documented as causing loops and RSTP
 * flapping, because the tagged traffic re-enters the same broadcast domain.
 */
function ruleBridgedVlanInterface(snap: DeviceSnapshot): ConfigFinding[] {
  const vlanNames = new Set(snap.vlanInterfaces.map((v) => v['name']).filter(Boolean));
  const out: ConfigFinding[] = [];
  for (const p of snap.bridgePorts) {
    const name = p['interface'];
    if (!name || !vlanNames.has(name)) continue;
    if (isTrue(p['disabled'])) continue;
    out.push({
      rule: 'bridged-vlan-interface',
      fingerprint: `bridged-vlan-interface:${p['bridge']}:${name}`,
      severity: 'critical',
      title: `VLAN interface ${name} is a port of bridge ${p['bridge']}`,
      detail:
        `Adding a VLAN interface as a bridge port feeds tagged traffic back into the same `
        + `broadcast domain it came from. This creates a forwarding loop, and where STP is `
        + `running it shows up as ports flapping between forwarding and blocking.`,
      remediation:
        `Remove ${name} from bridge ${p['bridge']} and use the bridge VLAN table to carry the `
        + `VLAN on the physical ports instead.`,
      docUrl: L2_DOC,
      objects: [name, p['bridge']],
    });
  }
  return out;
}

/**
 * A bonding slave that is also directly a bridge port. The bond and the bridge both
 * claim the interface; traffic takes an undefined path and the bond loses members
 * without saying so.
 */
function ruleBondSlaveIsBridgePort(snap: DeviceSnapshot): ConfigFinding[] {
  const ports = activeBridgePorts(snap);
  const out: ConfigFinding[] = [];
  for (const bond of snap.bonds) {
    if (isTrue(bond['disabled'])) continue;
    for (const slave of rosList(bond['slaves'])) {
      const port = ports.get(slave);
      if (!port) continue;
      out.push({
        rule: 'bond-slave-is-bridge-port',
        fingerprint: `bond-slave-is-bridge-port:${bond['name']}:${slave}`,
        severity: 'critical',
        title: `${slave} is both a slave of bond ${bond['name']} and a port of bridge ${port['bridge']}`,
        detail:
          `An interface can belong to a bond or to a bridge, not both. With both configured the `
          + `forwarding path is undefined: frames may bypass the bond, and the bond silently runs `
          + `with fewer working members than it reports.`,
        remediation:
          `Remove ${slave} from bridge ${port['bridge']} and add the bond ${bond['name']} as the `
          + `bridge port instead.`,
        docUrl: BRIDGING_DOC,
        objects: [slave, bond['name'], port['bridge']],
      });
    }
  }
  return out;
}

/**
 * MTU above L2MTU. The interface accepts the larger MTU and then cannot carry it;
 * small packets pass and large ones vanish, which is why this usually surfaces as
 * "the network works but file transfers hang".
 */
function ruleMtuExceedsL2Mtu(snap: DeviceSnapshot): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  for (const i of snap.interfaces) {
    if (isTrue(i['disabled'])) continue;
    const mtu = parseInt(i['mtu'] || '', 10);
    const l2mtu = parseInt(i['l2mtu'] || '', 10);
    if (isNaN(mtu) || isNaN(l2mtu) || l2mtu <= 0) continue;
    if (mtu <= l2mtu) continue;
    out.push({
      rule: 'mtu-exceeds-l2mtu',
      fingerprint: `mtu-exceeds-l2mtu:${i['name']}`,
      severity: 'warning',
      title: `${i['name']} has MTU ${mtu} above its L2MTU of ${l2mtu}`,
      detail:
        `The interface is configured to carry ${mtu}-byte payloads but the underlying layer-2 `
        + `path only supports ${l2mtu}. Frames above the L2MTU are dropped without an error, so `
        + `small traffic works while large transfers stall.`,
      remediation:
        `Lower the MTU on ${i['name']} to ${l2mtu} or below, or raise the L2MTU on this interface `
        + `and every interface along the path.`,
      docUrl: L2_DOC,
      objects: [i['name']],
    });
  }
  return out;
}

/**
 * A bridge VLAN entry covering several VLANs while also listing untagged ports.
 * RouterOS prints a warning for this and applies it anyway: every listed VLAN
 * becomes untagged on those ports, which is almost never what was intended.
 */
function ruleMultiVidUntagged(snap: DeviceSnapshot): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  for (const row of snap.bridgeVlans) {
    if (isTrue(row['dynamic'])) continue;
    const vids = expandVlanIds(row['vlan-ids']);
    if (vids.length < 2) continue;
    const untagged = rosList(row['untagged']);
    if (untagged.length === 0) continue;
    out.push({
      rule: 'multi-vid-untagged',
      fingerprint: `multi-vid-untagged:${row['bridge']}:${row['vlan-ids']}`,
      severity: 'warning',
      title: `Bridge VLAN entry ${row['vlan-ids']} on ${row['bridge']} has untagged ports`,
      detail:
        `This one entry covers ${vids.length} VLANs and marks ${untagged.join(', ')} untagged in `
        + `all of them. A port can only meaningfully be untagged in one VLAN, so the result is `
        + `ambiguous. RouterOS warns about this and applies it regardless.`,
      remediation:
        `Split the entry: keep the range for tagged trunk ports, and give each untagged access `
        + `port its own single-VLAN entry with a matching PVID.`,
      docUrl: VLAN_TABLE_DOC,
      objects: [row['bridge'], row['vlan-ids'], ...untagged],
    });
  }
  return out;
}

/**
 * A PVID next to `frame-type=admit-only-vlan-tagged`. The docs are explicit that
 * this frame-type disables the dynamic untagged entry that a PVID would create, so
 * the PVID is inert — the classic "configuration that looks like it does something".
 */
function rulePvidWithTaggedOnlyFrameType(snap: DeviceSnapshot): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  for (const p of snap.bridgePorts) {
    if (isTrue(p['disabled'])) continue;
    if (p['frame-types'] !== 'admit-only-vlan-tagged' && p['frame-type'] !== 'admit-only-vlan-tagged') continue;
    const pvid = parseInt(p['pvid'] || '1', 10);
    if (isNaN(pvid) || pvid === 1) continue;
    out.push({
      rule: 'pvid-with-tagged-only-frame-type',
      fingerprint: `pvid-with-tagged-only-frame-type:${p['bridge']}:${p['interface']}`,
      severity: 'warning',
      title: `PVID ${pvid} on ${p['interface']} has no effect`,
      detail:
        `${p['interface']} admits only VLAN-tagged frames, which disables the dynamic untagged `
        + `entry a PVID would otherwise create. The PVID of ${pvid} is stored but never applied, `
        + `so untagged devices on this port are dropped rather than placed in VLAN ${pvid}.`,
      remediation:
        `Either set frame-types back to admit-all (or admit-only-untagged-and-priority-tagged) if `
        + `untagged traffic belongs here, or clear the PVID so the configuration says what it does.`,
      docUrl: VLAN_TABLE_DOC,
      objects: [p['interface'], p['bridge'], String(pvid)],
    });
  }
  return out;
}

/**
 * Hardware offload can only be applied to one bridge per switch chip. When a second
 * bridge also has hw ports, one of them silently falls back to CPU forwarding and
 * throughput collapses under load without any error.
 */
function ruleMultipleHwBridges(snap: DeviceSnapshot): ConfigFinding[] {
  const hwBridges = new Set<string>();
  for (const p of snap.bridgePorts) {
    if (isTrue(p['disabled'])) continue;
    if (isTrue(p['hw'])) hwBridges.add(p['bridge']);
  }
  if (hwBridges.size < 2) return [];
  const names = [...hwBridges].sort();
  return [{
    rule: 'multiple-hw-bridges',
    fingerprint: `multiple-hw-bridges:${names.join(',')}`,
    severity: 'warning',
    title: `${names.length} bridges request hardware offload (${names.join(', ')})`,
    detail:
      `A switch chip can hardware-offload the ports of only one bridge. With several bridges `
      + `asking for it, the ones that lose out fall back to CPU forwarding — no error is raised, `
      + `but throughput on those ports drops to what the CPU can handle.`,
    remediation:
      `Consolidate the ports onto a single hardware-offloaded bridge and separate the networks `
      + `with the bridge VLAN table, or accept CPU forwarding and disable hw on the extra bridges.`,
    docUrl: BRIDGING_DOC,
    objects: names,
  }];
}

/**
 * A VLAN interface on a VLAN-filtering bridge whose VLAN the bridge is not tagged
 * in. The bridge is the CPU port: without tagged membership the VLAN interface is
 * up and carries nothing.
 */
function ruleVlanIfaceNotTaggedOnBridge(snap: DeviceSnapshot): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  const filtering = new Set(
    snap.bridges.filter((b) => isTrue(b['vlan-filtering'])).map((b) => b['name'])
  );
  for (const v of snap.vlanInterfaces) {
    if (isTrue(v['disabled'])) continue;
    const parent = v['interface'] || '';
    if (!filtering.has(parent)) continue;
    const vid = parseInt(v['vlan-id'] || '', 10);
    if (isNaN(vid)) continue;
    const membership = vlanMembership(snap, parent, vid);
    if (membership.tagged.includes(parent)) continue;
    out.push({
      rule: 'vlan-iface-not-tagged-on-bridge',
      fingerprint: `vlan-iface-not-tagged-on-bridge:${v['name']}`,
      severity: 'critical',
      title: `${v['name']} carries no traffic — ${parent} is not tagged in VLAN ${vid}`,
      detail:
        `${parent} has VLAN filtering enabled, and the bridge itself is the CPU port. For `
        + `${v['name']} to receive VLAN ${vid}, ${parent} must be listed as a tagged member of `
        + `VLAN ${vid} in the bridge VLAN table. `
        + (membership.found
          ? `The VLAN exists on the bridge but ${parent} is not tagged in it.`
          : `There is no bridge VLAN entry for VLAN ${vid} at all.`),
      remediation:
        `Add ${parent} to the tagged list of VLAN ${vid} on bridge ${parent} in the bridge VLAN table.`,
      docUrl: VLAN_TABLE_DOC,
      objects: [v['name'], parent, String(vid)],
    });
  }
  return out;
}

/**
 * The management VLAN membership that keeps the manager connected exists only as a
 * dynamic entry created by a port PVID. It works right now, but any change that
 * stops PVIDs creating dynamic entries — setting frame-types to tagged-only being
 * the documented one — removes it and takes the device off the network.
 */
function ruleMgmtVlanDynamicOnly(snap: DeviceSnapshot, device: GuardDevice): ConfigFinding[] {
  const path = resolveManagementPath(snap, device);
  if (!path.bridge || !path.bridgeVlanFiltering || path.mgmtVlanId === null) return [];
  if (path.taggedManagement) return [];

  const vid = path.mgmtVlanId;
  const membership = vlanMembership(snap, path.bridge, vid);
  const effective = membership.untagged.includes(path.bridge) || membership.tagged.includes(path.bridge);
  const isStatic = membership.untaggedStatic.includes(path.bridge) || membership.taggedStatic.includes(path.bridge);
  if (!effective || isStatic) return [];

  return [{
    rule: 'mgmt-vlan-dynamic-only',
    fingerprint: `mgmt-vlan-dynamic-only:${path.bridge}:${vid}`,
    severity: 'warning',
    title: `Management on VLAN ${vid} depends on a dynamic bridge VLAN entry`,
    detail:
      `Bridge ${path.bridge} carries management on VLAN ${vid}, but its membership in that VLAN `
      + `is not configured — it exists only as a dynamic entry derived from a port PVID. That `
      + `entry disappears the moment a port is set to admit only tagged frames, and management `
      + `goes with it. Nothing in the saved configuration records why this device is reachable.`,
    remediation:
      `Add ${path.bridge} explicitly to VLAN ${vid} in the bridge VLAN table (untagged, matching `
      + `how management arrives today) so the reachability is written down rather than incidental.`,
    docUrl: VLAN_TABLE_DOC,
    objects: [path.bridge, String(vid)],
  }];
}

/**
 * A port on a VLAN-filtering bridge that belongs to no VLAN. Every frame entering it
 * is dropped by ingress filtering — the port is up, linked, and completely dead.
 */
function rulePortInNoVlan(snap: DeviceSnapshot): ConfigFinding[] {
  const filtering = new Set(
    snap.bridges.filter((b) => isTrue(b['vlan-filtering'])).map((b) => b['name'])
  );
  if (filtering.size === 0) return [];

  const member = new Set<string>();
  for (const row of snap.bridgeVlans) {
    for (const p of rosList(row['current-tagged'] ?? row['tagged'])) member.add(`${row['bridge']}:${p}`);
    for (const p of rosList(row['current-untagged'] ?? row['untagged'])) member.add(`${row['bridge']}:${p}`);
  }

  const out: ConfigFinding[] = [];
  for (const p of snap.bridgePorts) {
    const name = p['interface'];
    const bridge = p['bridge'];
    if (!name || !bridge || !filtering.has(bridge)) continue;
    if (isTrue(p['disabled']) || isTrue(p['inactive'])) continue;
    if (member.has(`${bridge}:${name}`)) continue;
    out.push({
      rule: 'port-in-no-vlan',
      fingerprint: `port-in-no-vlan:${bridge}:${name}`,
      severity: 'warning',
      title: `${name} is a member of no VLAN on VLAN-filtering bridge ${bridge}`,
      detail:
        `${bridge} enforces the VLAN table on ingress, and ${name} appears in no entry — not `
        + `tagged, not untagged, and not via a PVID-derived dynamic entry. Anything plugged into `
        + `this port links up and is then dropped silently.`,
      remediation:
        `Either add ${name} to the VLANs it should carry, or remove it from ${bridge} so the `
        + `configuration reflects that it is unused.`,
      docUrl: VLAN_TABLE_DOC,
      objects: [name, bridge],
    });
  }
  return out;
}

/**
 * Two interfaces holding the same address. Only one can answer; which one wins is
 * not something the configuration states.
 */
function ruleDuplicateAddress(snap: DeviceSnapshot): ConfigFinding[] {
  const byAddr = new Map<string, string[]>();
  for (const a of snap.addresses) {
    if (isTrue(a['disabled']) || isTrue(a['invalid'])) continue;
    const ip = stripCidr(a['address']);
    if (!ip) continue;
    const iface = a['actual-interface'] || a['interface'] || '?';
    byAddr.set(ip, [...(byAddr.get(ip) ?? []), iface]);
  }
  const out: ConfigFinding[] = [];
  for (const [ip, ifaces] of byAddr) {
    if (ifaces.length < 2) continue;
    out.push({
      rule: 'duplicate-address',
      fingerprint: `duplicate-address:${ip}`,
      severity: 'warning',
      title: `${ip} is configured on ${ifaces.length} interfaces`,
      detail:
        `${ip} appears on ${ifaces.join(', ')}. Only one of them can answer for it, and which one `
        + `depends on internal ordering rather than on anything in the configuration.`,
      remediation: `Remove the address from every interface except the one that should own it.`,
      docUrl: L2_DOC,
      objects: [ip, ...ifaces],
    });
  }
  return out;
}

// ─── audit ────────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Run every rule against a snapshot. Pure — no device or database access. */
export function auditConfig(snap: DeviceSnapshot, device: GuardDevice): ConfigFinding[] {
  const findings = [
    ...ruleIpOnBridgePort(snap),
    ...ruleVlanIfaceOnBridgePort(snap),
    ...ruleBridgedVlanInterface(snap),
    ...ruleBondSlaveIsBridgePort(snap),
    ...ruleVlanIfaceNotTaggedOnBridge(snap),
    ...ruleMgmtVlanDynamicOnly(snap, device),
    ...rulePortInNoVlan(snap),
    ...ruleMultiVidUntagged(snap),
    ...rulePvidWithTaggedOnlyFrameType(snap),
    ...ruleMultipleHwBridges(snap),
    ...ruleMtuExceedsL2Mtu(snap),
    ...ruleDuplicateAddress(snap),
  ];
  return findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rule.localeCompare(b.rule)
  );
}

export interface ConfigHealthResult {
  findings: ConfigFinding[];
  checkedAt: Date;
}

/**
 * Audit a device and persist the result. Findings are upserted so `first_seen`
 * records how long a problem has existed, and anything absent from this run is
 * removed — the table always describes the device as it is now.
 */
export async function runConfigHealth(device: GuardDevice): Promise<ConfigHealthResult> {
  const snap = await captureSnapshot(device);
  const findings = auditConfig(snap, device);
  const checkedAt = new Date();

  for (const f of findings) {
    await query(
      `INSERT INTO device_config_findings
         (device_id, rule, fingerprint, severity, title, detail, remediation, doc_url, objects, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (device_id, fingerprint) DO UPDATE SET
         rule=$2, severity=$4, title=$5, detail=$6, remediation=$7, doc_url=$8, objects=$9, last_seen=NOW()`,
      [device.id, f.rule, f.fingerprint, f.severity, f.title, f.detail, f.remediation, f.docUrl, f.objects]
    );
  }

  await query(
    `DELETE FROM device_config_findings
     WHERE device_id = $1 AND NOT (fingerprint = ANY($2::text[]))`,
    [device.id, findings.map((f) => f.fingerprint)]
  );

  await query(`UPDATE devices SET config_health_checked_at = NOW() WHERE id = $1`, [device.id]);

  return { findings, checkedAt };
}
