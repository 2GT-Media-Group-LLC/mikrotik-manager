import { Router, Request, Response } from 'express';
import { deviceSiteAccess, deviceIdQuery } from '../utils/siteAccess';
import { deviceWriteLock, deviceIdFromQuery } from '../services/changeGuard/deviceLock';
import { withGuardedChange } from '../services/changeGuard/guardedRoute';
import type { PlannedChange } from '../services/changeGuard/analyzeChange';
import { query, queryOne } from '../config/database';
import { readManagementTunnel, peerRule, type ManagementTunnel, type TunnelVerdict } from '../services/changeGuard/wireguardPath';
import { requireAuth, requireWrite } from '../middleware/auth';
import { maskSecretsForReadOnly } from '../utils/redactSecrets';
import { siteScopeDevices } from '../utils/siteScope';
import { activeSite, writableScope } from '../middleware/site';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import { netflowCollector } from '../services/netflow/NetflowCollector';
import { getLldpStatuses, setLldpForTypes, parseDeviceTypes, LLDP_DEVICE_TYPES } from '../services/lldpApply';
import { applySnmpConfig, getSnmpStatuses, getSnmpTemplates, SnmpInputError, type SnmpConfigInput, type SnmpTarget } from '../services/snmpApply';

const router = Router();
router.use(requireAuth);
// A site-scoped account only reaches devices in its own sites, with its role there (P1-7).
router.use(deviceSiteAccess(deviceIdQuery));
// Viewers and read-only tokens never receive device secrets (Wi-Fi keys,
// WireGuard private keys, SNMP communities, hotspot passwords).
router.use(maskSecretsForReadOnly);
// One write at a time per device, so a Change Guard revert can't undo another write.
router.use(deviceWriteLock(deviceIdFromQuery));

// ─── Helper ───────────────────────────────────────────────────────────────────

async function withDevice<T>(
  deviceId: number,
  res: Response,
  fn: (collector: DeviceCollector, device: DeviceRow) => Promise<T>
): Promise<T | void> {
  const rows = await query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
  const device = rows[0];
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  const collector = new DeviceCollector(device);
  try {
    await collector.connect();
    return await fn(collector, device);
  } finally {
    collector.disconnect();
  }
}

function deviceIdParam(req: Request, res: Response): number | null {
  const id = parseInt(req.query.deviceId as string);
  if (!id) { res.status(400).json({ error: 'deviceId query param is required' }); return null; }
  return id;
}

// ─── Overview (all online devices, all services) ──────────────────────────────

// ─── LLDP, fleet-wide ──────────────────────────────────────────────────────────
// Every RouterOS device has neighbour-discovery settings, not only routers and
// switches. ?types= / device_types narrow it (router, switch, wireless_ap, other);
// omitted means every type. Both are scoped to the active site.

router.get('/lldp', async (req: Request, res: Response) => {
  const types = parseDeviceTypes(req.query.types);
  if (!types) return res.status(400).json({ error: `types must be from: ${LLDP_DEVICE_TYPES.join(', ')}` });
  return res.json(await getLldpStatuses(types, activeSite(req)));
});

router.put('/lldp', requireWrite, async (req: Request, res: Response) => {
  const { enabled, device_types } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '"enabled" (boolean) is required' });
  }
  const types = parseDeviceTypes(device_types);
  if (!types) return res.status(400).json({ error: `device_types must be from: ${LLDP_DEVICE_TYPES.join(', ')}` });
  return res.json(await setLldpForTypes(types, enabled, writableScope(req)));
});

// ─── SNMP, fleet-wide ──────────────────────────────────────────────────────────
// Every device type, like LLDP. Changes go only to the devices named in
// device_ids, or to every online device in the site with "all" (optionally
// narrowed by device_types). There is no default: a request that doesn't say
// which devices is refused.

router.get('/snmp', async (req: Request, res: Response) => {
  const types = req.query.types ? parseDeviceTypes(req.query.types) : undefined;
  if (types === null) return res.status(400).json({ error: `types must be from: ${LLDP_DEVICE_TYPES.join(', ')}` });
  return res.json(await getSnmpStatuses(activeSite(req), types));
});

// The contact / location / trap destination last applied, as typed (#164).
router.get('/snmp/templates', async (_req: Request, res: Response) => {
  return res.json(await getSnmpTemplates());
});

router.put('/snmp', requireWrite, async (req: Request, res: Response) => {
  const { device_ids, device_types, ...config } = (req.body ?? {}) as Record<string, unknown>;
  let target: SnmpTarget;
  if (device_ids === 'all') {
    const types = device_types === undefined ? undefined : parseDeviceTypes(device_types);
    if (types === null) return res.status(400).json({ error: `device_types must be from: ${LLDP_DEVICE_TYPES.join(', ')}` });
    target = { all: true, deviceTypes: types };
  } else if (Array.isArray(device_ids) && device_ids.every((id) => Number.isInteger(id))) {
    target = { deviceIds: device_ids as number[] };
  } else {
    return res.status(400).json({ error: 'device_ids is required: a list of device ids, or "all"' });
  }
  try {
    return res.json(await applySnmpConfig(target, config as SnmpConfigInput, writableScope(req)));
  } catch (e) {
    if (e instanceof SnmpInputError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

router.get('/overview', async (req: Request, res: Response) => {
  const siteFilter = siteScopeDevices(activeSite(req));
  const devices = await query<DeviceRow>(
    `SELECT * FROM devices WHERE status = 'online'
       ${siteFilter ? `AND ${siteFilter}` : ''} ORDER BY name`
  );

  const results = await Promise.allSettled(
    devices.map(async (device: DeviceRow) => {
      const collector = new DeviceCollector(device);
      try {
        await collector.connect();
        const [dhcpV4, dhcpV6, dns, ntp, wg, syslogActions] = await Promise.allSettled([
          collector.getDhcpServers('ipv4'),
          collector.getDhcpServers('ipv6'),
          collector.getDnsSettings(),
          collector.getNtpSettings(),
          collector.getWireGuardInterfaces(),
          collector.getSyslogActions(),
        ]);

        const v4Servers    = dhcpV4.status === 'fulfilled' ? dhcpV4.value : [];
        const v6Servers    = dhcpV6.status === 'fulfilled' ? dhcpV6.value : [];
        const dnsRow       = dns.status === 'fulfilled' ? dns.value : null;
        const ntpRow       = ntp.status === 'fulfilled' ? ntp.value : null;
        const wgIfaces     = wg.status === 'fulfilled' ? wg.value : [];
        const syslogActs   = syslogActions.status === 'fulfilled' ? syslogActions.value : [];

        return {
          id: device.id, name: device.name, ip_address: device.ip_address,
          dhcp_v4: { total: v4Servers.length, enabled: v4Servers.filter(s => s['disabled'] !== 'true').length },
          dhcp_v6: { total: v6Servers.length, enabled: v6Servers.filter(s => s['disabled'] !== 'true').length },
          dns: dnsRow ? { allow_remote: dnsRow['allow-remote-requests'] === 'yes', servers: dnsRow['servers'] || '' } : null,
          ntp: ntpRow ? { server_enabled: ntpRow.server['enabled'] === 'yes', client_enabled: ntpRow.client['enabled'] === 'yes' } : null,
          wireguard: { total: wgIfaces.length, running: wgIfaces.filter(i => i['running'] === 'true').length },
          // RouterOS calls it `target`; the built-in `remote` action points at
          // 0.0.0.0 until configured, so it isn't a destination (C7).
          syslog: { remote_count: syslogActs.filter(a => a['target'] === 'remote' && !!a['remote'] && a['remote'] !== '0.0.0.0').length },
        };
      } catch (err) {
        return { id: device.id, name: device.name, ip_address: device.ip_address,
          dhcp_v4: null, dhcp_v6: null, dns: null, ntp: null, wireguard: null, syslog: null,
          error: (err as Error).message };
      } finally {
        collector.disconnect();
      }
    })
  );

  res.json(results.map(r => r.status === 'fulfilled' ? r.value : { error: (r.reason as Error).message }));
});

// ─── DHCP ─────────────────────────────────────────────────────────────────────

// GET /api/network-services/dhcp?deviceId=X
router.get('/dhcp', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    const [v4, v6, pv4, pv6, ifaces] = await Promise.allSettled([
      collector.getDhcpServers('ipv4'),
      collector.getDhcpServers('ipv6'),
      collector.getDhcpPools('ipv4'),
      collector.getDhcpPools('ipv6'),
      collector.getDhcpInterfaces(),
    ]);
    res.json({
      ipv4: v4.status === 'fulfilled' ? v4.value : [],
      ipv6: v6.status === 'fulfilled' ? v6.value : [],
      pools_v4: pv4.status === 'fulfilled' ? pv4.value : [],
      pools_v6: pv6.status === 'fulfilled' ? pv6.value : [],
      interfaces: ifaces.status === 'fulfilled' ? ifaces.value : [],
    });
  });
});

// POST /api/network-services/dhcp/server?deviceId=X — create DHCP server
router.post('/dhcp/server', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { protocol, ...params } = req.body;
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol must be "ipv4" or "ipv6"' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.addDhcpServer(params, protocol as 'ipv4' | 'ipv6');
    const updated = await collector.getDhcpServers(protocol as 'ipv4' | 'ipv6');
    res.json(updated);
  });
});

// PUT /api/network-services/dhcp/server/:id?deviceId=X — update DHCP server
router.put('/dhcp/server/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { protocol, ...params } = req.body;
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.updateDhcpServer(req.params.id, params, protocol as 'ipv4' | 'ipv6');
    const updated = await collector.getDhcpServers(protocol as 'ipv4' | 'ipv6');
    res.json(updated);
  });
});

// DELETE /api/network-services/dhcp/server/:id?deviceId=X&protocol=X — delete DHCP server
router.delete('/dhcp/server/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const protocol = req.query.protocol as string;
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol query param required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeDhcpServer(req.params.id, protocol as 'ipv4' | 'ipv6');
    res.json({ success: true });
  });
});

// PUT /api/network-services/dhcp/server — toggle enable/disable (legacy compat)
router.put('/dhcp/server', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { serverId, disabled, protocol } = req.body;
  if (!serverId) return res.status(400).json({ error: 'serverId is required' });
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) is required' });
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.setDhcpServerDisabled(serverId, disabled, protocol as 'ipv4' | 'ipv6');
    res.json({ success: true });
  });
});

// GET /api/network-services/dhcp/pools?deviceId=X&protocol=X
router.get('/dhcp/pools', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const protocol = req.query.protocol as string;
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol query param required' });
  await withDevice(deviceId, res, async (collector) => {
    const pools = await collector.getDhcpPools(protocol as 'ipv4' | 'ipv6');
    res.json(pools);
  });
});

// POST /api/network-services/dhcp/pool?deviceId=X — add pool
router.post('/dhcp/pool', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { protocol, ...params } = req.body;
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.addDhcpPool(params, protocol as 'ipv4' | 'ipv6');
    const updated = await collector.getDhcpPools(protocol as 'ipv4' | 'ipv6');
    res.json(updated);
  });
});

// DELETE /api/network-services/dhcp/pool/:id?deviceId=X&protocol=X — remove pool
router.delete('/dhcp/pool/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const protocol = req.query.protocol as string;
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol query param required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeDhcpPool(req.params.id, protocol as 'ipv4' | 'ipv6');
    res.json({ success: true });
  });
});

// GET /api/network-services/dhcp/leases?deviceId=X&protocol=X
router.get('/dhcp/leases', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const protocol = (req.query.protocol as string) || 'ipv4';
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol must be ipv4 or ipv6' });
  await withDevice(deviceId, res, async (collector) => {
    const leases = await collector.getDhcpLeases(protocol as 'ipv4' | 'ipv6');
    res.json(leases);
  });
});

// POST /api/network-services/dhcp/static-lease?deviceId=X — add static lease
router.post('/dhcp/static-lease', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { protocol, ...params } = req.body;
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol required' });
  if (protocol === 'ipv6' && params['mac-address'] !== undefined) {
    return res.status(400).json({ error: 'An IPv6 binding is matched by the client DUID, not a MAC address.' });
  }
  await withDevice(deviceId, res, async (collector) => {
    await collector.addStaticDhcpLease(params, protocol as 'ipv4' | 'ipv6');
    res.json({ success: true });
  });
});

// DELETE /api/network-services/dhcp/static-lease/:id?deviceId=X&protocol=X
router.delete('/dhcp/static-lease/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const protocol = (req.query.protocol as string) || 'ipv4';
  if (protocol !== 'ipv4' && protocol !== 'ipv6') return res.status(400).json({ error: 'protocol required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeStaticDhcpLease(req.params.id, protocol as 'ipv4' | 'ipv6');
    res.json({ success: true });
  });
});

// ─── DNS ──────────────────────────────────────────────────────────────────────

// GET /api/network-services/dns?deviceId=X
router.get('/dns', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    const [settings, statics] = await Promise.allSettled([
      collector.getDnsSettings(),
      collector.getDnsStaticEntries(),
    ]);
    res.json({
      settings: settings.status === 'fulfilled' ? settings.value : {},
      statics: statics.status === 'fulfilled' ? statics.value : [],
    });
  });
});

// PUT /api/network-services/dns?deviceId=X
router.put('/dns', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.setDnsSettings(req.body);
    const updated = await collector.getDnsSettings();
    res.json(updated);
  });
});

// POST /api/network-services/dns/flush?deviceId=X
router.post('/dns/flush', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.flushDnsCache();
    res.json({ success: true });
  });
});

// GET /api/network-services/dns/static?deviceId=X
router.get('/dns/static', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    const entries = await collector.getDnsStaticEntries();
    res.json(entries);
  });
});

// POST /api/network-services/dns/static?deviceId=X
router.post('/dns/static', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.addDnsStaticEntry(req.body);
    const updated = await collector.getDnsStaticEntries();
    res.json(updated);
  });
});

// PUT /api/network-services/dns/static/:id?deviceId=X
router.put('/dns/static/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.updateDnsStaticEntry(req.params.id, req.body);
    const updated = await collector.getDnsStaticEntries();
    res.json(updated);
  });
});

// DELETE /api/network-services/dns/static/:id?deviceId=X
router.delete('/dns/static/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeDnsStaticEntry(req.params.id);
    res.json({ success: true });
  });
});

// ─── NTP ──────────────────────────────────────────────────────────────────────

// GET /api/network-services/ntp?deviceId=X
router.get('/ntp', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    const settings = await collector.getNtpSettings();
    res.json(settings);
  });
});

// PUT /api/network-services/ntp?deviceId=X
router.put('/ntp', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.setNtpSettings(req.body);
    const updated = await collector.getNtpSettings();
    res.json(updated);
  });
});

// ─── WireGuard ────────────────────────────────────────────────────────────────

// GET /api/network-services/wireguard?deviceId=X
router.get('/wireguard', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    const [interfaces, peers] = await Promise.allSettled([
      collector.getWireGuardInterfaces(),
      collector.getWireGuardPeers(),
    ]);
    // Which interface and peers carry the manager's own connection, so the
    // page can mark them and not offer to delete or disable them (#205).
    const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
    const tunnel = device ? await readManagementTunnel(device) : null;
    res.json({
      interfaces: interfaces.status === 'fulfilled' ? interfaces.value : [],
      peers: peers.status === 'fulfilled' ? peers.value : [],
      management: tunnel?.interface
        ? { interface: tunnel.interface, interface_id: tunnel.interfaceId, peer_ids: tunnel.peerIds, peer_certain: tunnel.peerCertain, reason: tunnel.reason }
        : null,
    });
  });
});

// WireGuard writes run under Change Guard (outside review P2-8). On top of that,
// the tunnel the manager arrives through is protected (#205): deleting or
// disabling it, or the peer carrying the manager, is refused outright, and any
// other change to them must be able to undo itself.

const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 'yes';

/**
 * Look up the management tunnel and apply a route's rule to it. Returns false
 * when the change was refused (the 409 is already sent), else whether it has
 * to run under auto-revert. A device that can't be read falls back to the
 * ordinary Change Guard checks.
 */
async function tunnelGate(deviceId: number, res: Response, rule: (t: ManagementTunnel) => TunnelVerdict): Promise<false | { protect: boolean }> {
  const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
  const tunnel = device ? await readManagementTunnel(device) : null;
  if (!tunnel?.interface) return { protect: false };
  const verdict = rule(tunnel);
  if (verdict && 'refuse' in verdict) {
    res.status(409).json({ lockout: true, reason: `${verdict.refuse} ${tunnel.reason}`, management_tunnel: true });
    return false;
  }
  return { protect: !!verdict };
}

const isMgmtIface = (t: ManagementTunnel, idOrName: string) => idOrName === t.interfaceId || idOrName === t.interface;
const elsewhere = 'Make this change on the device itself, or move management off this tunnel first.';

// POST /api/network-services/wireguard?deviceId=X — add interface
router.post('/wireguard', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withGuardedChange(deviceId, req, res, { kind: 'wireguard.add', summary: 'Add WireGuard interface' },
    async (c) => { await c.addWireGuardInterface(req.body); return { success: true }; });
});

// PUT /api/network-services/wireguard/toggle — enable/disable (must be before /:id)
router.put('/wireguard/toggle', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { interfaceId, disabled } = req.body;
  if (!interfaceId) return res.status(400).json({ error: 'interfaceId is required' });
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) is required' });
  const gate = await tunnelGate(deviceId, res, (t) => isMgmtIface(t, String(interfaceId))
    ? (disabled ? { refuse: `${t.interface} is the WireGuard tunnel the manager reaches this device through; turning it off would cut the manager off. ${elsewhere}` } : { protect: true })
    : null);
  if (!gate) return;
  await withGuardedChange(deviceId, req, res,
    { kind: 'wireguard.toggle', summary: `${disabled ? 'Disable' : 'Enable'} WireGuard interface`, protect: gate.protect,
      change: { kind: 'interface.disable', name: String(interfaceId), disabled } },
    async (c) => { await c.setWireGuardInterfaceDisabled(interfaceId, disabled); return { success: true }; });
});

// PUT /api/network-services/wireguard/:id?deviceId=X — update interface
router.put('/wireguard/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const gate = await tunnelGate(deviceId, res, (t) => isMgmtIface(t, req.params.id)
    ? (truthy(req.body?.disabled)
      ? { refuse: `${t.interface} is the WireGuard tunnel the manager reaches this device through; turning it off would cut the manager off. ${elsewhere}` }
      : { protect: true })
    : null);
  if (!gate) return;
  await withGuardedChange(deviceId, req, res,
    { kind: 'wireguard.set', summary: 'Edit WireGuard interface', protect: gate.protect,
      change: { kind: 'path-object.change', name: String(req.body?.name ?? req.params.id), what: 'Changing this WireGuard interface' } },
    async (c) => { await c.updateWireGuardInterface(req.params.id, req.body); return { success: true }; });
});

// DELETE /api/network-services/wireguard/:id?deviceId=X — delete interface
router.delete('/wireguard/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const gate = await tunnelGate(deviceId, res, (t) => isMgmtIface(t, req.params.id)
    ? { refuse: `${t.interface} is the WireGuard tunnel the manager reaches this device through; deleting it would cut the manager off. ${elsewhere}` }
    : null);
  if (!gate) return;
  await withGuardedChange(deviceId, req, res,
    // For reachability, a deleted tunnel is a disabled one.
    { kind: 'wireguard.remove', summary: 'Delete WireGuard interface', protect: gate.protect,
      change: { kind: 'interface.disable', name: req.params.id, disabled: true } },
    async (c) => { await c.removeWireGuardInterface(req.params.id); return { success: true }; });
});

// Peers change what the tunnel carries; a peer on the manager's tunnel is flagged.
const peerChange = (req: Request): PlannedChange | undefined => {
  const iface = (req.body as { interface?: string } | undefined)?.interface;
  return iface ? { kind: 'path-object.change', name: String(iface), what: 'Changing a WireGuard peer' } : undefined;
};

// POST /api/network-services/wireguard/peer?deviceId=X — add peer
router.post('/wireguard/peer', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const gate = await tunnelGate(deviceId, res, (t) => peerRule(t, null, req.body, 'add'));
  if (!gate) return;
  await withGuardedChange(deviceId, req, res, { kind: 'wireguard.peer.add', summary: 'Add WireGuard peer', change: peerChange(req), protect: gate.protect },
    async (c) => { await c.addWireGuardPeer(req.body); return { success: true }; });
});

// PUT /api/network-services/wireguard/peer/:id?deviceId=X — update peer
router.put('/wireguard/peer/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const gate = await tunnelGate(deviceId, res, (t) => peerRule(t, req.params.id, req.body, 'set'));
  if (!gate) return;
  await withGuardedChange(deviceId, req, res, { kind: 'wireguard.peer.set', summary: 'Edit WireGuard peer', change: peerChange(req), protect: gate.protect },
    async (c) => { await c.updateWireGuardPeer(req.params.id, req.body); return { success: true }; });
});

// DELETE /api/network-services/wireguard/peer/:id?deviceId=X — delete peer
router.delete('/wireguard/peer/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const gate = await tunnelGate(deviceId, res, (t) => peerRule(t, req.params.id, undefined, 'remove'));
  if (!gate) return;
  await withGuardedChange(deviceId, req, res, { kind: 'wireguard.peer.remove', summary: 'Delete WireGuard peer', protect: gate.protect },
    async (c) => { await c.removeWireGuardPeer(req.params.id); return { success: true }; });
});

// ─── Syslog ───────────────────────────────────────────────────────────────────

// GET /api/network-services/syslog?deviceId=X
router.get('/syslog', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    const [actions, rules] = await Promise.allSettled([
      collector.getSyslogActions(),
      collector.getSyslogRules(),
    ]);
    res.json({
      actions: actions.status === 'fulfilled' ? actions.value : [],
      rules: rules.status === 'fulfilled' ? rules.value : [],
    });
  });
});

// POST /api/network-services/syslog/action?deviceId=X
router.post('/syslog/action', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.addSyslogAction(req.body);
    const updated = await collector.getSyslogActions();
    res.json(updated);
  });
});

// PUT /api/network-services/syslog/action/:id?deviceId=X
router.put('/syslog/action/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.updateSyslogAction(req.params.id, req.body);
    const updated = await collector.getSyslogActions();
    res.json(updated);
  });
});

// DELETE /api/network-services/syslog/action/:id?deviceId=X
router.delete('/syslog/action/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeSyslogAction(req.params.id);
    res.json({ success: true });
  });
});

// PUT /api/network-services/syslog/rule/toggle?deviceId=X — must be before /:id
router.put('/syslog/rule/toggle', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { ruleId, disabled } = req.body;
  if (!ruleId) return res.status(400).json({ error: 'ruleId is required' });
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) is required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.toggleSyslogRule(ruleId, disabled);
    res.json({ success: true });
  });
});

// POST /api/network-services/syslog/rule?deviceId=X
router.post('/syslog/rule', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.addSyslogRule(req.body);
    const updated = await collector.getSyslogRules();
    res.json(updated);
  });
});

// PUT /api/network-services/syslog/rule/:id?deviceId=X
router.put('/syslog/rule/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.updateSyslogRule(req.params.id, req.body);
    const updated = await collector.getSyslogRules();
    res.json(updated);
  });
});

// DELETE /api/network-services/syslog/rule/:id?deviceId=X
router.delete('/syslog/rule/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeSyslogRule(req.params.id);
    res.json({ success: true });
  });
});

// ─── NetFlow / Traffic Flow ───────────────────────────────────────────────────

async function getNetflowAppSettings(): Promise<{
  address: string; port: number; version: string; activeTimeout: string; inactiveTimeout: string;
}> {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings
     WHERE key IN ('netflow_collector_address', 'netflow_collector_port', 'netflow_version',
                   'netflow_active_timeout', 'netflow_inactive_timeout')`
  );
  const map: Record<string, unknown> = {};
  for (const row of rows) map[row.key] = row.value;
  return {
    address: String(map['netflow_collector_address'] || ''),
    port: Number(map['netflow_collector_port']) || 2055,
    version: String(map['netflow_version'] || '9'),
    activeTimeout: String(map['netflow_active_timeout'] || '1m'),
    inactiveTimeout: String(map['netflow_inactive_timeout'] || '15s'),
  };
}

function targetMatchesCollector(
  targets: Record<string, string>[],
  collector: { address: string; port: number }
): boolean {
  return targets.some(
    (t) => t['dst-address'] === collector.address && Number(t['port']) === collector.port && t['disabled'] !== 'true'
  );
}

// GET /api/network-services/netflow/fleet — traffic-flow state for all online devices
router.get('/netflow/fleet', async (req: Request, res: Response) => {
  const settings = await getNetflowAppSettings();
  const stats = netflowCollector.getStats();
  const statsByDevice = new Map(stats.exporters.map((e) => [e.deviceId, e]));
  const siteFilter = siteScopeDevices(activeSite(req));
  const devices = await query<DeviceRow>(
    `SELECT * FROM devices WHERE status = 'online'
       ${siteFilter ? `AND ${siteFilter}` : ''} ORDER BY name`
  );

  const results = await Promise.allSettled(
    devices.map(async (device: DeviceRow) => {
      const collector = new DeviceCollector(device);
      try {
        await collector.connect();
        const [tfSettings, targets] = await Promise.all([
          collector.getTrafficFlowSettings(),
          collector.getTrafficFlowTargets(),
        ]);
        const exporterStats = statsByDevice.get(device.id);
        return {
          id: device.id,
          name: device.name,
          ip_address: device.ip_address,
          enabled: tfSettings?.['enabled'] === 'true' || tfSettings?.['enabled'] === 'yes',
          interfaces: tfSettings?.['interfaces'] || '',
          targets: targets.map((t) => ({
            id: t['.id'],
            dst_address: t['dst-address'],
            port: Number(t['port']) || 0,
            version: t['version'] || '',
            disabled: t['disabled'] === 'true',
          })),
          target_matches_collector: targetMatchesCollector(targets, settings),
          flows_received: exporterStats?.flows || 0,
          last_flow_at: exporterStats?.lastSeen || null,
        };
      } catch (err) {
        return {
          id: device.id, name: device.name, ip_address: device.ip_address,
          enabled: null, interfaces: '', targets: [], target_matches_collector: false,
          flows_received: 0, last_flow_at: null, error: (err as Error).message,
        };
      } finally {
        collector.disconnect();
      }
    })
  );

  res.json({
    collector: { ...settings, listening: stats.listening },
    devices: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: (r.reason as Error).message })),
  });
});

// GET /api/network-services/netflow?deviceId=X — single device traffic-flow state
router.get('/netflow', async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const settings = await getNetflowAppSettings();
  await withDevice(deviceId, res, async (collector) => {
    const [tfSettings, targets] = await Promise.all([
      collector.getTrafficFlowSettings(),
      collector.getTrafficFlowTargets(),
    ]);
    res.json({
      settings: tfSettings,
      targets,
      target_matches_collector: targetMatchesCollector(targets, settings),
    });
  });
});

// PUT /api/network-services/netflow?deviceId=X — body { enabled: boolean }
// Enable: upsert our export target (matched by dst-address + port) and turn
// traffic-flow on. Disable: remove our target; only turn traffic-flow off if
// no other (user-managed) targets remain.
router.put('/netflow', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });

  const settings = await getNetflowAppSettings();
  if (enabled && !settings.address) {
    return res.status(400).json({ error: 'Set the collector address in NetFlow settings before enabling devices' });
  }

  await withDevice(deviceId, res, async (collector) => {
    const targets = await collector.getTrafficFlowTargets();
    const ours = targets.find(
      (t) => t['dst-address'] === settings.address && Number(t['port']) === settings.port
    );

    if (enabled) {
      const targetParams: Record<string, string> = {
        'dst-address': settings.address,
        port: String(settings.port),
        version: settings.version === 'ipfix' ? 'ipfix' : '9',
      };
      if (settings.version !== 'ipfix') {
        // Re-send templates frequently so the collector can decode data
        // promptly after a backend restart clears its template cache.
        targetParams['v9-template-refresh'] = '20';
        targetParams['v9-template-timeout'] = '1m';
      }
      if (ours) {
        await collector.updateTrafficFlowTarget(ours['.id'], targetParams);
      } else {
        await collector.addTrafficFlowTarget(targetParams);
      }
      await collector.setTrafficFlowSettings({
        enabled: 'yes',
        interfaces: 'all',
        'active-flow-timeout': settings.activeTimeout,
        'inactive-flow-timeout': settings.inactiveTimeout,
      });
    } else {
      if (ours) await collector.removeTrafficFlowTarget(ours['.id']);
      const remaining = (await collector.getTrafficFlowTargets()).filter((t) => t['.id'] !== ours?.['.id']);
      if (remaining.length === 0) {
        await collector.setTrafficFlowSettings({ enabled: 'no' });
      }
    }

    const [tfSettings, updatedTargets] = await Promise.all([
      collector.getTrafficFlowSettings(),
      collector.getTrafficFlowTargets(),
    ]);
    res.json({
      settings: tfSettings,
      targets: updatedTargets,
      target_matches_collector: targetMatchesCollector(updatedTargets, settings),
    });
  });
});

export default router;
