import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { Client as SshClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import dotenv from 'dotenv';

dotenv.config();

import { pool, queryOne, query } from './config/database';
import { initOuiDatabase } from './utils/oui';
import { redis } from './config/redis';
import { runMigrations } from './db/migrate';
import { errorHandler } from './middleware/errorHandler';
import { PollerService } from './services/PollerService';
import {
  setBulkAddPollerService,
  startBulkAddWorker,
  stopBulkAddWorker,
} from './services/DeviceBulkAddWorker';
import { netflowCollector } from './services/netflow/NetflowCollector';
import { verifyToken, type AuthPayload } from './middleware/auth';
import { rateLimitRedis } from './middleware/rateLimitRedis';
import { initSecrets } from './utils/secrets';
import { reencryptStaleCredentials } from './db/reencryptCredentials';
import { reconcileStaleGuards } from './services/changeGuard/ChangeGuard';
import { decrypt } from './utils/crypto';
import { corsMiddlewareOptions, socketIoCorsOptions } from './utils/corsOrigins';

import authRoutes from './routes/auth';
import oidcRoutes from './routes/oidc';
import auditLogRoutes from './routes/auditLog';
import tagsRoutes from './routes/tags';
import maintenanceWindowsRoutes from './routes/maintenanceWindows';
import devicesRoutes, { setPollerService as setDevicesPoller } from './routes/devices';
import clientsRoutes, { setPollerService as setClientsPoller } from './routes/clients';
import eventsRoutes from './routes/events';
import backupsRoutes from './routes/backups';
import guestWifiRoutes from './routes/guestWifi';
import firmwareRoutes from './routes/firmware';
import automationRoutes from './routes/automation';
import { reportService } from './services/ReportService';
import { firmwareOrchestrator } from './services/FirmwareOrchestrator';
import operationsRoutes from './routes/operations';
import metricsRoutes from './routes/metrics';
import topologyRoutes, { setPollerService as setTopologyPoller } from './routes/topology';
import settingsRoutes from './routes/settings';
import certRoutes from './routes/cert';
import searchRoutes from './routes/search';
import switchesRoutes from './routes/switches';
import routersRoutes from './routes/routers';
import alertsRoutes from './routes/alerts';
import configTemplatesRoutes from './routes/configTemplates';
import configHistoryRoutes from './routes/configHistory';
import wirelessRoutes from './routes/wireless';
import networkServicesRoutes from './routes/networkServices';
import trafficAnalyticsRoutes from './routes/trafficAnalytics';
import credentialPresetsRoutes from './routes/credentialPresets';
import systemRoutes, { setPollerService as setSystemPoller } from './routes/system';
import { auditMiddleware } from './middleware/auditMiddleware';

// ─── Secret hygiene ───────────────────────────────────────────────────────────
// Self-healing: if JWT_SECRET / ENCRYPTION_KEY aren't set to strong values, we
// auto-generate strong ones and persist them, so a deployment is never left on
// the public repo defaults and never breaks on upgrade. See utils/secrets.ts.
function provisionSecrets(): void {
  const info = initSecrets();
  const sourceLine = `secrets: jwt=${info.jwtSource}, encryption=${info.encSource}`;
  if (info.jwtSource === 'generated' || info.encSource === 'generated') {
    console.log(`[secrets] auto-generated strong secret(s) (${sourceLine})`);
  } else {
    console.log(`[secrets] ${sourceLine}`);
  }
  if (info.ephemeral) {
    console.error(
      '[secrets] WARNING: generated secrets could not be persisted (SECRETS_DIR not writable). ' +
      'They will change on restart — users will be logged out and credentials written now may not ' +
      'decrypt later. Mount a writable volume at SECRETS_DIR (default /app/data) or set JWT_SECRET/ENCRYPTION_KEY.'
    );
  }
}

const app = express();
// nginx sits exactly one hop in front; trust its X-Forwarded-For so req.ip is the real client IP
app.set('trust proxy', 1);
const httpServer = createServer(app);
const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: socketIoCorsOptions(),
  path: '/socket.io',
});

// The default namespace broadcasts fleet-activity events (device/client/event
// updates); require a valid JWT so unauthenticated clients can't subscribe.
io.use((socket, next) => {
  const token = (socket.handshake.auth as { token?: string })?.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.data.user = verifyToken(token);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ─── SSH Terminal namespace ────────────────────────────────────────────────────
const terminalNs = io.of('/terminal');

// Roles allowed to open an interactive device shell. The stored SSH account is
// the router admin, so console access mirrors requireWrite: viewers are rejected.
const TERMINAL_ROLES = new Set(['admin', 'operator']);

// Per-user rate limit on shell starts (in-memory; sliding window).
const TERMINAL_START_LIMIT = 5;
const TERMINAL_START_WINDOW_MS = 60_000;
const terminalStartHistory = new Map<number, number[]>();

function terminalStartAllowed(userId: number): boolean {
  const now = Date.now();
  const recent = (terminalStartHistory.get(userId) ?? []).filter(
    (t) => now - t < TERMINAL_START_WINDOW_MS
  );
  if (recent.length >= TERMINAL_START_LIMIT) {
    terminalStartHistory.set(userId, recent);
    return false;
  }
  recent.push(now);
  terminalStartHistory.set(userId, recent);
  return true;
}

function auditTerminal(user: AuthPayload, ip: string, summary: string, deviceId?: number): void {
  query(
    `INSERT INTO audit_log (user_id, username, method, path, entity_type, entity_id, summary, ip_address, status_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user.userId, user.username, 'SSH', '/terminal', 'device', deviceId ?? null, summary, ip, 200]
  ).catch(() => {});
}

terminalNs.use((socket, next) => {
  const token = (socket.handshake.auth as { token?: string })?.token;
  if (!token) return next(new Error('No token'));
  try {
    const payload = verifyToken(token);
    if (!TERMINAL_ROLES.has(payload.role)) {
      return next(new Error('Console access denied for this role'));
    }
    socket.data.user = payload;
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

terminalNs.on('connection', (socket) => {
  let sshClient: SshClient | null = null;
  let shellStream: ClientChannel | null = null;
  const user = socket.data.user as AuthPayload;
  const clientIp = (socket.handshake.address ?? '').replace(/^::ffff:/, '');

  socket.on('start', async (payload: { deviceId: number; cols?: number; rows?: number }) => {
    const { deviceId, cols = 80, rows = 24 } = payload;
    try {
      // Defense in depth: re-check the connection's role at the sink, not just at handshake.
      if (!user || !TERMINAL_ROLES.has(user.role)) {
        socket.emit('error', 'Console access denied for this role');
        return;
      }
      if (!terminalStartAllowed(user.userId)) {
        auditTerminal(user, clientIp, `terminal start rate-limited for device ${deviceId}`, deviceId);
        socket.emit('error', 'Too many terminal sessions started. Please wait a moment and try again.');
        return;
      }
      const device = await queryOne<{
        ip_address: string;
        ssh_port: number | null;
        ssh_username: string | null;
        ssh_password_encrypted: string | null;
      }>(
        `SELECT ip_address, ssh_port, ssh_username, ssh_password_encrypted FROM devices WHERE id = $1`,
        [deviceId]
      );

      if (!device) { socket.emit('error', 'Device not found'); return; }
      if (!device.ssh_username || !device.ssh_password_encrypted) {
        socket.emit('error', 'No SSH credentials configured for this device. Add an SSH username and password in device settings.');
        return;
      }

      const password = decrypt(device.ssh_password_encrypted);
      sshClient = new SshClient();

      sshClient.on('ready', () => {
        sshClient!.shell(
          { term: 'xterm-256color', cols, rows },
          (err, stream) => {
            if (err) { socket.emit('error', err.message); return; }
            shellStream = stream;
            auditTerminal(user, clientIp, `opened SSH shell on device ${deviceId} (${device.ip_address})`, deviceId);
            socket.emit('ready');

            stream.on('data', (data: Buffer) => {
              socket.emit('data', data.toString('binary'));
            });
            stream.stderr.on('data', (data: Buffer) => {
              socket.emit('data', data.toString('binary'));
            });
            stream.on('close', () => {
              socket.emit('close');
              sshClient?.end();
            });
          }
        );
      });

      sshClient.on('error', (err) => {
        socket.emit('error', `SSH error: ${err.message}`);
      });

      sshClient.connect({
        host: device.ip_address,
        port: device.ssh_port ?? 22,
        username: device.ssh_username,
        password,
        readyTimeout: 10_000,
        algorithms: {
          kex: [
            'ecdh-sha2-nistp256',
            'ecdh-sha2-nistp384',
            'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group14-sha1',
            'diffie-hellman-group1-sha1',
          ],
          serverHostKey: [
            'ssh-rsa',
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ssh-ed25519',
          ],
        },
      });
    } catch (err) {
      socket.emit('error', `Connection failed: ${(err as Error).message}`);
    }
  });

  socket.on('data', (data: string) => {
    shellStream?.write(data);
  });

  socket.on('resize', ({ cols, rows }: { cols: number; rows: number }) => {
    shellStream?.setWindow(rows, cols, 0, 0);
  });

  socket.on('disconnect', () => {
    shellStream?.end();
    sshClient?.end();
    shellStream = null;
    sshClient = null;
  });
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsMiddlewareOptions()));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}
app.use(auditMiddleware);

// Global backstop rate limit on mutating API requests (per user, falling back to
// per IP before auth runs). Endpoints with stricter needs add their own limiter.
app.use('/api', rateLimitRedis({ windowSec: 60, max: 120, keyPrefix: 'api-global' }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth/oidc', oidcRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/guest-wifi', guestWifiRoutes);
app.use('/api/firmware', firmwareRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/topology', topologyRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/cert', certRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/switches', switchesRoutes);
app.use('/api/routers', routersRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/wireless', wirelessRoutes);
app.use('/api/network-services', networkServicesRoutes);
app.use('/api/traffic', trafficAnalyticsRoutes);
app.use('/api/credential-presets', credentialPresetsRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/maintenance-windows', maintenanceWindowsRoutes);
app.use('/api/config-templates', configTemplatesRoutes);
app.use('/api/config-history', configHistoryRoutes);
app.use('/api/system', systemRoutes);

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Startup ─────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  provisionSecrets();

  // Wait for DB to be ready
  for (let i = 0; i < 10; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (i === 9) throw err;
      console.log(`Waiting for database... (${i + 1}/10)`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Run migrations
  await runMigrations();

  // Migrate any credentials still encrypted under a legacy/default key forward
  // to the current key (runs in the background; safe to skip on failure).
  reencryptStaleCredentials().catch((e) =>
    console.warn('[secrets] credential re-encryption sweep skipped:', (e as Error).message)
  );

  // Guards left 'pending' belong to a manager that stopped mid-change; the device
  // has since restored itself, so settle those rows.
  reconcileStaleGuards().catch(() => {});

  // Reset vendor entries that were previously set to '' due to API rate-limiting,
  // so they get re-resolved by the new local OUI database.
  await query(`UPDATE clients SET vendor = NULL WHERE vendor = ''`).catch(() => {});

  // Start loading the OUI database in the background (doesn't block startup)
  initOuiDatabase().catch(() => {});

  // Connect Redis
  await redis.connect().catch(() => console.warn('Redis connection warning'));

  // Start poller
  const pollerService = new PollerService();
  pollerService.setSocketServer(io);
  setDevicesPoller(pollerService);
  setSystemPoller(pollerService);
  setBulkAddPollerService(pollerService);
  setTopologyPoller(pollerService);
  setClientsPoller(pollerService);
  await pollerService.start();

  // Trim job history left over from before retention limits existed. Runs in the
  // background: an installation with millions of retained jobs would otherwise
  // hold up startup, and nothing depends on it having finished.
  void pollerService.cleanupJobHistory().catch((e) =>
    console.error('[Poller] Job history cleanup failed:', e));
  await startBulkAddWorker();

  // NetFlow/IPFIX collector (binds its UDP socket only when netflow_enabled)
  await netflowCollector.start();

  // Firmware rollout scheduler (starts rollouts whose scheduled_at has arrived)
  firmwareOrchestrator.startScheduler();

  // Scheduled report mailer (hourly check)
  reportService.startScheduler();

  // Start HTTP server
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Mikrotik Manager backend running on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await stopBulkAddWorker();
    await netflowCollector.stop();
    await pollerService.stop();
    await redis.quit().catch(() => {});
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
