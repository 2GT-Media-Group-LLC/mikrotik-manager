/**
 * Live Torch (#416): RouterOS's /tool/torch on one interface, streamed to the
 * browser over a socket.io namespace once a second.
 *
 * Torch only reads, but it costs the router CPU while it runs, so a session is
 * bounded: one per browser socket, a few per device, a hard time limit, and it
 * is cancelled on the device the moment the page closes or the user stops it.
 */
import type { Namespace, Server, Socket } from 'socket.io';
import { query, queryOne } from '../config/database';
import type { AuthPayload } from '../middleware/auth';
import { decrypt } from '../utils/crypto';
import { usesApiTls } from '../utils/apiTls';
import { routeOf } from './jumpHosts';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import type { DeviceRow } from './mikrotik/DeviceCollector';

/** Roles that may run Torch: the same as the other device tools (requireWrite). */
export const TORCH_ROLES = new Set(['admin', 'operator']);
/** Longest one Torch session runs before it stops by itself. */
export const TORCH_MAX_MS = 10 * 60_000;
/** Torch sessions at once on one device, across all users. */
const PER_DEVICE_MAX = 2;
/** Flows sent per frame, busiest first. */
const MAX_FLOWS = 200;
/** No rows for this long: send an empty frame so the page shows the link is quiet. */
const QUIET_MS = 2_500;
const START_LIMIT = 10;
const START_WINDOW_MS = 60_000;

const perDevice = new Map<number, number>();
const startHistory = new Map<number, number[]>();

export interface TorchRequest {
  deviceId: number;
  interface: string;
  srcAddress?: string;
  dstAddress?: string;
  port?: string;
  protocol?: string;
}

export interface TorchFlow {
  mac: string;
  proto: string;
  src: string;
  srcPort: string;
  dst: string;
  dstPort: string;
  /** Bits per second, as Torch reports them. */
  tx: number;
  rx: number;
  txPackets: number;
  rxPackets: number;
}

const IPV4_CIDR = /^(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?$/;
const IPV6_CIDR = /^[0-9a-f:]+(\/\d{1,3})?$/i;
const PROTOCOLS = new Set(['any', 'tcp', 'udp', 'icmp', 'icmpv6', 'gre', 'esp', 'ospf']);

/** The /tool/torch parameters for a request, or an error to show. */
export function torchParams(r: TorchRequest): { params: Record<string, string> } | { error: string } {
  const iface = String(r.interface ?? '').trim();
  if (!iface || iface.length > 64 || /[\r\n=]/.test(iface)) return { error: 'Pick an interface.' };
  const params: Record<string, string> = { interface: iface };
  // Matching every address and port is what makes Torch list each flow;
  // without these it shows only totals.
  const addr = (v: string | undefined, v4Key: string, v6Key: string): string | null => {
    const a = String(v ?? '').trim();
    if (!a) { params[v4Key] = '0.0.0.0/0'; params[v6Key] = '::/0'; return null; }
    if (IPV4_CIDR.test(a)) { params[v4Key] = a; return null; }
    if (a.includes(':') && IPV6_CIDR.test(a)) { params[v6Key] = a; return null; }
    return `${a} isn't an IPv4 or IPv6 address or prefix.`;
  };
  const e1 = addr(r.srcAddress, 'src-address', 'src-address6');
  if (e1) return { error: e1 };
  const e2 = addr(r.dstAddress, 'dst-address', 'dst-address6');
  if (e2) return { error: e2 };
  const port = String(r.port ?? '').trim() || 'any';
  if (port !== 'any') {
    const n = Number(port);
    if (!/^\d+$/.test(port) || n < 1 || n > 65535) return { error: 'Port is a number from 1 to 65535, or empty for any.' };
  }
  params.port = port;
  const proto = String(r.protocol ?? '').trim().toLowerCase() || 'any';
  if (!PROTOCOLS.has(proto)) return { error: `Protocol is one of: ${[...PROTOCOLS].join(', ')}.` };
  params['ip-protocol'] = proto;
  return { params };
}

/** One Torch row as the page shows it. */
export function toFlow(row: Record<string, string>): TorchFlow {
  const num = (k: string) => Number(row[k] ?? 0) || 0;
  return {
    mac: row['mac-protocol'] ?? '',
    proto: row['ip-protocol'] ?? '',
    src: row['src-address'] ?? row['src-address6'] ?? '',
    srcPort: row['src-port'] ?? '',
    dst: row['dst-address'] ?? row['dst-address6'] ?? '',
    dstPort: row['dst-port'] ?? '',
    tx: num('tx'),
    rx: num('rx'),
    txPackets: num('tx-packets'),
    rxPackets: num('rx-packets'),
  };
}

/** A frame's flows, busiest first and capped. */
export function frameOf(rows: Record<string, string>[]): { flows: TorchFlow[]; total: number } {
  const flows = rows.map(toFlow).sort((a, b) => (b.tx + b.rx) - (a.tx + a.rx));
  return { flows: flows.slice(0, MAX_FLOWS), total: flows.length };
}

function startAllowed(userId: number): boolean {
  const now = Date.now();
  const recent = (startHistory.get(userId) ?? []).filter((t) => now - t < START_WINDOW_MS);
  if (recent.length >= START_LIMIT) { startHistory.set(userId, recent); return false; }
  recent.push(now);
  startHistory.set(userId, recent);
  return true;
}

function audit(user: AuthPayload, ip: string, summary: string, deviceId: number): void {
  query(
    `INSERT INTO audit_log (user_id, username, method, path, entity_type, entity_id, summary, ip_address, status_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user.userId, user.username, 'TORCH', '/torch', 'device', deviceId, summary, ip, 200]
  ).catch(() => {});
}

interface TorchDeps {
  socketSession: (token: string | undefined) => Promise<AuthPayload | null>;
  roleOnDevice: (user: AuthPayload, deviceId: number) => Promise<string | null>;
  clientIp: (socket: Socket) => string;
}

/** The /torch namespace. Events: start(TorchRequest), stop; frame, started, stopped, error. */
export function attachTorch(io: Server, deps: TorchDeps): Namespace {
  const ns = io.of('/torch');

  ns.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string })?.token;
    void deps.socketSession(token).then((user) => {
      if (!user) return next(new Error('Invalid or expired token'));
      if (user.mustChangePassword) return next(new Error('Change the default password first'));
      if (!TORCH_ROLES.has(user.role)) return next(new Error('Torch is for operators and admins'));
      socket.data.user = user;
      socket.data.token = token;
      next();
    });
  });

  ns.on('connection', (socket) => {
    let abort: AbortController | null = null;
    const stop = () => { abort?.abort(); };
    socket.on('stop', stop);
    socket.on('disconnect', stop);

    socket.on('start', async (req: TorchRequest) => {
      if (abort) { socket.emit('error', 'Torch is already running here. Stop it first.'); return; }
      const deviceId = Number(req?.deviceId);
      const current = await deps.socketSession(socket.data.token as string | undefined);
      if (!current) { socket.emit('error', 'Your session has ended. Please sign in again.'); return; }
      const role = await deps.roleOnDevice(current, deviceId);
      if (!role) { socket.emit('error', 'Device not found'); return; }
      if (!TORCH_ROLES.has(role)) { socket.emit('error', 'Torch is for operators and admins'); return; }
      const p = torchParams(req);
      if ('error' in p) { socket.emit('error', p.error); return; }
      if (!startAllowed(current.userId)) { socket.emit('error', 'Too many Torch sessions started. Wait a minute and try again.'); return; }
      if ((perDevice.get(deviceId) ?? 0) >= PER_DEVICE_MAX) {
        socket.emit('error', `Torch is already running ${PER_DEVICE_MAX} times on this device. Try again when one stops.`);
        return;
      }
      const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
      if (!device) { socket.emit('error', 'Device not found'); return; }
      if ((device as DeviceRow & { ssh_only?: boolean }).ssh_only) {
        socket.emit('error', 'Torch runs over the API, which this device doesn\'t have yet.');
        return;
      }

      // The page may have closed during the checks above; nothing would stop it then.
      if (!socket.connected || abort) return;
      const ctrl = new AbortController();
      abort = ctrl;
      perDevice.set(deviceId, (perDevice.get(deviceId) ?? 0) + 1);
      audit(current, deps.clientIp(socket), `torch on ${p.params.interface} of device ${deviceId}`, deviceId);

      const client = new RouterOSClient(
        device.ip_address, device.api_port, device.api_username,
        decrypt(device.api_password_encrypted),
        15_000, 15_000, usesApiTls(device), routeOf(device),
      );
      let section: string | null = null;
      let rows: Record<string, string>[] = [];
      let lastRowAt = Date.now();
      const flush = () => {
        socket.emit('frame', { at: Date.now(), ...frameOf(rows) });
        rows = [];
      };
      const quiet = setInterval(() => {
        if (Date.now() - lastRowAt >= QUIET_MS) { lastRowAt = Date.now(); section = null; rows = []; flush(); }
      }, 1_000);
      const reason = { text: 'stopped' };
      try {
        await client.connect();
        socket.emit('started', { maxMs: TORCH_MAX_MS, interface: p.params.interface });
        await client.executeStreaming('/tool/torch', p.params, TORCH_MAX_MS, {
          signal: ctrl.signal,
          onRow: (row) => {
            lastRowAt = Date.now();
            const s = row['.section'] ?? '';
            if (section !== null && s !== section) flush();
            section = s;
            rows.push(row);
          },
        });
        if (!ctrl.signal.aborted) reason.text = 'time limit';
      } catch (err) {
        reason.text = 'error';
        socket.emit('error', (err as Error).message);
      } finally {
        clearInterval(quiet);
        client.disconnect();
        perDevice.set(deviceId, Math.max(0, (perDevice.get(deviceId) ?? 1) - 1));
        abort = null;
        socket.emit('stopped', { reason: reason.text });
      }
    });
  });

  return ns;
}
