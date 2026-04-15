import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';

const router = Router();
router.use(requireAuth);

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

router.get('/overview', async (_req: Request, res: Response) => {
  const devices = await query<DeviceRow>(`SELECT * FROM devices WHERE status = 'online' ORDER BY name`);

  const results = await Promise.allSettled(
    devices.map(async (device: DeviceRow) => {
      const collector = new DeviceCollector(device);
      try {
        await collector.connect();
        const [dhcpV4, dhcpV6, dns, ntp, wg] = await Promise.allSettled([
          collector.getDhcpServers('ipv4'),
          collector.getDhcpServers('ipv6'),
          collector.getDnsSettings(),
          collector.getNtpSettings(),
          collector.getWireGuardInterfaces(),
        ]);

        const v4Servers = dhcpV4.status === 'fulfilled' ? dhcpV4.value : [];
        const v6Servers = dhcpV6.status === 'fulfilled' ? dhcpV6.value : [];
        const dnsRow    = dns.status === 'fulfilled' ? dns.value : null;
        const ntpRow    = ntp.status === 'fulfilled' ? ntp.value : null;
        const wgIfaces  = wg.status === 'fulfilled' ? wg.value : [];

        return {
          id: device.id, name: device.name, ip_address: device.ip_address,
          dhcp_v4: { total: v4Servers.length, enabled: v4Servers.filter(s => s['disabled'] !== 'true').length },
          dhcp_v6: { total: v6Servers.length, enabled: v6Servers.filter(s => s['disabled'] !== 'true').length },
          dns: dnsRow ? { allow_remote: dnsRow['allow-remote-requests'] === 'yes', servers: dnsRow['servers'] || '' } : null,
          ntp: ntpRow ? { server_enabled: ntpRow.server['enabled'] === 'yes', client_enabled: ntpRow.client['enabled'] === 'yes' } : null,
          wireguard: { total: wgIfaces.length, running: wgIfaces.filter(i => i['running'] === 'true').length },
        };
      } catch (err) {
        return { id: device.id, name: device.name, ip_address: device.ip_address,
          dhcp_v4: null, dhcp_v6: null, dns: null, ntp: null, wireguard: null,
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
    res.json({
      interfaces: interfaces.status === 'fulfilled' ? interfaces.value : [],
      peers: peers.status === 'fulfilled' ? peers.value : [],
    });
  });
});

// POST /api/network-services/wireguard?deviceId=X — create interface
router.post('/wireguard', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    const interfaces = await collector.addWireGuardInterface(req.body);
    res.json(interfaces);
  });
});

// PUT /api/network-services/wireguard/toggle — enable/disable (must be before /:id)
router.put('/wireguard/toggle', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  const { interfaceId, disabled } = req.body;
  if (!interfaceId) return res.status(400).json({ error: 'interfaceId is required' });
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) is required' });
  await withDevice(deviceId, res, async (collector) => {
    await collector.setWireGuardInterfaceDisabled(interfaceId, disabled);
    res.json({ success: true });
  });
});

// PUT /api/network-services/wireguard/:id?deviceId=X — update interface
router.put('/wireguard/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.updateWireGuardInterface(req.params.id, req.body);
    const updated = await collector.getWireGuardInterfaces();
    res.json(updated);
  });
});

// DELETE /api/network-services/wireguard/:id?deviceId=X — delete interface
router.delete('/wireguard/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeWireGuardInterface(req.params.id);
    res.json({ success: true });
  });
});

// POST /api/network-services/wireguard/peer?deviceId=X — add peer
router.post('/wireguard/peer', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.addWireGuardPeer(req.body);
    const peers = await collector.getWireGuardPeers();
    res.json(peers);
  });
});

// PUT /api/network-services/wireguard/peer/:id?deviceId=X — update peer
router.put('/wireguard/peer/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.updateWireGuardPeer(req.params.id, req.body);
    const peers = await collector.getWireGuardPeers();
    res.json(peers);
  });
});

// DELETE /api/network-services/wireguard/peer/:id?deviceId=X — delete peer
router.delete('/wireguard/peer/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = deviceIdParam(req, res); if (!deviceId) return;
  await withDevice(deviceId, res, async (collector) => {
    await collector.removeWireGuardPeer(req.params.id);
    res.json({ success: true });
  });
});

export default router;
