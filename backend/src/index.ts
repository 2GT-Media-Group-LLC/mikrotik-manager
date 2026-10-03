import 'express-async-errors';
import { clientIpBehindProxy } from './utils/clientIp';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { Client as SshClient } from 'ssh2';
import { resolveAuth, type SshExecDevice } from './services/sshExec';
import type { ClientChannel } from 'ssh2';
import dotenv from 'dotenv';

dotenv.config();

import { pool, queryOne, query } from './config/database';
import { initOuiDatabase } from './utils/oui';
import { redis } from './config/redis';
import { runMigrations } from './db/migrate';
import { errorHandler } from './middleware/errorHandler';
import { PollerService } from './services/PollerService';
import { setSharedPollerService } from './services/pollerRef';
import {
  setBulkAddPollerService,
  startBulkAddWorker,
  stopBulkAddWorker,
} from './services/DeviceBulkAddWorker';
import { startSshKeyFleetWorker, stopSshKeyFleetWorker } from './services/SshKeyFleetWorker';
import sshKeysRoutes from './routes/sshKeys';
import commandTemplatesRoutes from './routes/commandTemplates';
import { convertConfigTemplates } from './services/convertConfigTemplates';
import { netflowCollector } from './services/netflow/NetflowCollector';
import { verifyToken, highestRole, type AuthPayload } from './middleware/auth';
import { roleOnDevice } from './utils/siteAccess';
import { validateSession } from './utils/sessionState';
import { verifyDeviceIdentity } from './services/identityPins';
import { RouterOSClient } from './services/mikrotik/RouterOSClient';
import { rateLimitRedis } from './middleware/rateLimitRedis';
import { initSecrets, confirmEncryptionKey } from './utils/secrets';
import { countUnreadable, reencryptAll, sealPlaintextSecrets } from './services/encryptedData';
import { reconcileStaleGuards } from './services/changeGuard/ChangeGuard';
import { corsMiddlewareOptions, socketIoCorsOptions } from './utils/corsOrigins';

import authRoutes from './routes/auth';
import oidcRoutes from './routes/oidc';
import auditLogRoutes from './routes/auditLog';
import tagsRoutes from './routes/tags';
import maintenanceWindowsRoutes from './routes/maintenanceWindows';
import devicesRoutes, { setPollerService as setDevicesPoller } from './routes/devices';
import clientsRoutes, { setPollerService as setClientsPoller } from './routes/clients';
import eventsRoutes from './routes/events';
import proxyRoutes from './routes/proxy';
import backupsRoutes from './routes/backups';
import guestWifiRoutes from './routes/guestWifi';
import firmwareRoutes from './routes/firmware';
import firmwareMirrorRoutes from './routes/firmwareMirror';
import { startMirrorScheduler } from './services/firmwareMirror';
import automationRoutes from './routes/automation';
import { reportService } from './services/ReportService';
import { firmwareOrchestrator } from './services/FirmwareOrchestrator';
import { commandRunner } from './services/CommandRunner';
import operationsRoutes from './routes/operations';
import metricsRoutes from './routes/metrics';
import topologyRoutes, { setPollerService as setTopologyPoller } from './routes/topology';
import settingsRoutes from './routes/settings';
import certRoutes from './routes/cert';
import searchRoutes from './routes/search';
import switchesRoutes from './routes/switches';
import routersRoutes from './routes/routers';
import alertsRoutes, { ensureDefaultRules } from './routes/alerts';
import configTemplatesRoutes from './routes/configTemplates';
import configHistoryRoutes from './routes/configHistory';
import wirelessRoutes from './routes/wireless';
import networkServicesRoutes from './routes/networkServices';
import trafficAnalyticsRoutes from './routes/trafficAnalytics';
import credentialPresetsRoutes from './routes/credentialPresets';
import commandRoutes from './routes/commands';
import systemRoutes, { setPollerService as setSystemPoller } from './routes/system';
import sitesRoutes from './routes/sites';
import certificatesRoutes from './routes/certificates';
import cveRoutes from './routes/cves';
import adoptionRoutes, { setPollerService as setAdoptionPoller } from './routes/adoption';
import { siteContext } from './middleware/site';
import { auditMiddleware } from './middleware/auditMiddleware';
import { sshHostCheck, explainSshError } from './services/sshHostCheck';

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
  if (info.envJwtIgnored) {
    console.warn(
      '[secrets] JWT_SECRET in the environment is a placeholder or shorter than 32 characters, ' +
      'so it is ignored and a generated secret is used instead. Remove it from .env or set a long random value.'
    );
  }
  if (info.ephemeral) {
    console.error(
      '[secrets] WARNING: generated secrets could not be persisted (SECRETS_DIR not writable). ' +
      'They will change on restart — users will be logged out and credentials written now may not ' +
      'decrypt later. Mount a writable volume at SECRETS_DIR (default /app/data) or set JWT_SECRET/ENCRYPTION_KEY.'
    );
  }
}

// Every API-SSL connection checks the device's certificate against the one it
// presented first, before sending the login (outside review P1-4).
RouterOSClient.tlsVerifier = (host, port, fingerprint) => verifyDeviceIdentity('api-tls', host, port, fingerprint);

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
/**
 * A socket's session as the account stands now, or null. Checked when the
 * socket connects and again every minute, so an expired, logged-out, demoted
 * or deleted session is disconnected instead of streaming on (P2-1).
 */
async function socketSession(token: string | undefined): Promise<AuthPayload | null> {
  if (!token) return null;
  try {
    const user = await validateSession(verifyToken(token));
    // A site-scoped account's socket carries its highest site role; opening a
    // shell then checks its role in that device's site (P1-7).
    if (user?.siteRoles) user.role = highestRole(Object.values(user.siteRoles));
    return user;
  } catch {
    return null;
  }
}

/** The live-update rooms an account belongs in: 'fleet', or one per site (P1-7). */
function socketRooms(user: AuthPayload): string[] {
  return user.siteRoles ? Object.keys(user.siteRoles).sort().map((id) => `site:${id}`) : ['fleet'];
}

io.use((socket, next) => {
  const token = (socket.handshake.auth as { token?: string })?.token;
  void socketSession(token).then((user) => {
    if (!user) return next(new Error('Invalid or expired token'));
    // A session that must change the default password gets nothing else.
    if (user.mustChangePassword) return next(new Error('Change the default password first'));
    socket.data.user = user;
    socket.data.token = token;
    next();
  });
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  // Device updates are sent to 'fleet' and to the device's site room only, so
  // a site-scoped account hears nothing about other sites (P1-7).
  const rooms = socketRooms(socket.data.user as AuthPayload);
  socket.data.rooms = rooms.join(',');
  void socket.join(rooms);
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
  void socketSession(token).then((user) => {
    if (!user) return next(new Error('Invalid or expired token'));
    if (user.mustChangePassword) return next(new Error('Change the default password first'));
    if (!TERMINAL_ROLES.has(user.role)) {
      return next(new Error('Console access denied for this role'));
    }
    socket.data.user = user;
    socket.data.token = token;
    next();
  });
});

// Re-check every open socket's session once a minute. Sockets used to keep the
// payload they connected with, so a terminal stayed open after its session had
// expired, been logged out or lost its role.
const SOCKET_RECHECK_MS = 60_000;
setInterval(() => {
  const check = async (socket: import('socket.io').Socket, allowed?: Set<string>) => {
    const user = await socketSession(socket.data.token as string | undefined);
    // Site access changed: reconnecting puts the socket in the right rooms.
    const roomsChanged = !allowed && !!user && socketRooms(user).join(',') !== socket.data.rooms;
    if (!user || user.mustChangePassword || roomsChanged || (allowed && !allowed.has(user.role))) {
      socket.emit('error', 'Your session has ended. Please sign in again.');
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;
  };
  for (const s of io.sockets.sockets.values()) void check(s);
  for (const s of terminalNs.sockets.values()) void check(s, TERMINAL_ROLES);
}, SOCKET_RECHECK_MS).unref();

terminalNs.on('connection', (socket) => {
  let sshClient: SshClient | null = null;
  let shellStream: ClientChannel | null = null;
  const user = socket.data.user as AuthPayload;
  // The user's address, not nginx's (P2-33).
  const clientIp = clientIpBehindProxy(socket.handshake.headers['x-forwarded-for'], socket.handshake.address);

  socket.on('start', async (payload: { deviceId: number; cols?: number; rows?: number }) => {
    const { deviceId, cols = 80, rows = 24 } = payload;
    try {
      // Re-check the session and role as they are now, right before opening a
      // shell, not as they were when the socket connected (P2-1).
      const current = await socketSession(socket.data.token as string | undefined);
      if (!current || !TERMINAL_ROLES.has(current.role)) {
        socket.emit('error', current ? 'Console access denied for this role' : 'Your session has ended. Please sign in again.');
        return;
      }
      if (!terminalStartAllowed(user.userId)) {
        auditTerminal(user, clientIp, `terminal start rate-limited for device ${deviceId}`, deviceId);
        socket.emit('error', 'Too many terminal sessions started. Please wait a moment and try again.');
        return;
      }
      const device = await queryOne<SshExecDevice>(
        `SELECT id, name, ip_address, ssh_port, ssh_username, ssh_password_encrypted,
                api_username, api_password_encrypted
           FROM devices WHERE id = $1`,
        [deviceId]
      );

      if (!device) { socket.emit('error', 'Device not found'); return; }
      // Its role in this device's site, not just anywhere (P1-7); a device in
      // another site is "not found".
      const roleHere = await roleOnDevice(current, deviceId);
      if (!roleHere) { socket.emit('error', 'Device not found'); return; }
      if (!TERMINAL_ROLES.has(roleHere)) { socket.emit('error', 'Console access denied for this role'); return; }

      // Resolve credentials the same way every other SSH consumer does, so a
      // deployed key works here too. Doing this locally, and looking only at
      // the stored password, is what broke the console once a key replaced the
      // password (#133).
      let auth: Awaited<ReturnType<typeof resolveAuth>>;
      try {
        auth = await resolveAuth(device);
      } catch (e) {
        socket.emit('error',
          `${(e as Error).message}. Add an SSH username and password in device settings, ` +
          `or deploy an SSH key for this device.`);
        return;
      }
      sshClient = new SshClient();

      sshClient.on('ready', () => {
        sshClient!.shell(
          { term: 'xterm-256color', cols, rows },
          (err, stream) => {
            if (err) { socket.emit('error', err.message); return; }
            shellStream = stream;
            auditTerminal(user, clientIp, `opened SSH shell on device ${deviceId} (${device.ip_address}) using ${auth.kind} auth`, deviceId);
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
        socket.emit('error', `SSH error: ${explainSshError(err, device.ip_address, device.ssh_port ?? 22).message}`);
      });

      sshClient.connect({
        host: device.ip_address,
        port: device.ssh_port ?? 22,
        username: auth.username,
        ...auth.auth,
        ...sshHostCheck(device.ip_address, device.ssh_port ?? 22),
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
// Resolve the active site once, before any route reads it (issue #130).
app.use('/api', siteContext);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth/oidc', oidcRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/adoption', adoptionRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/guest-wifi', guestWifiRoutes);
// Before /api/firmware, whose router would otherwise see these paths first (#193).
app.use('/api/firmware/mirrors', firmwareMirrorRoutes);
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
app.use('/api/commands', commandRoutes);
app.use('/api/sites', sitesRoutes);
app.use('/api/ssh-keys', sshKeysRoutes);
app.use('/api/command-templates', commandTemplatesRoutes);
app.use('/api/certificates', certificatesRoutes);
app.use('/api/security/cves', cveRoutes);

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
  await ensureDefaultRules().catch((e) => console.warn('[startup] default alert rules:', (e as Error).message));
  await convertConfigTemplates().catch((e) => console.warn('[startup] config template conversion:', (e as Error).message));

  // Before anything new is encrypted: is there stored data no known key opens?
  // Then the key was lost, and a freshly generated one must not be saved over
  // the problem (outside review P2-29). Otherwise save any new key and move
  // old ciphertext forward to the current key in the background.
  try {
    const unreadable = await countUnreadable();
    const { lost } = confirmEncryptionKey(unreadable);
    if (lost) {
      console.error(
        `[secrets] ${unreadable} stored credential(s) can't be decrypted with any known key. The encryption key ` +
        'is missing: restore secrets.json to the app_data volume, or set ENCRYPTION_KEY (or ENCRYPTION_KEY_PREVIOUS) ' +
        'to the original key, then restart. Saving new credentials is refused until then.');
    } else {
      // Seal any alert channel / webhook secret still in plaintext (S7), then
      // move everything to the current key.
      sealPlaintextSecrets()
        .then(() => reencryptAll())
        .catch((e) => console.warn('[secrets] re-encryption sweep failed:', (e as Error).message));
    }
  } catch (e) {
    console.warn('[secrets] could not check stored credentials:', (e as Error).message);
  }

  // Guards left 'pending' belong to a manager that stopped mid-change; the device
  // has since restored itself, so settle those rows.
  reconcileStaleGuards().catch(() => {});

  // Reset vendor entries that were previously set to '' due to API rate-limiting,
  // so they get re-resolved by the new local OUI database.
  await query(`UPDATE clients SET vendor = NULL WHERE vendor = ''`).catch(() => {});

  // Start loading the OUI database in the background (doesn't block startup)
  // Dark Site Mode: read before the first download attempt, which happens here.
  const ouiAllowed = await query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = 'oui_download_enabled'`
  ).then((r) => r[0]?.value !== false).catch(() => true);
  initOuiDatabase(ouiAllowed).catch(() => {});

  // Connect Redis
  await redis.connect().catch(() => console.warn('Redis connection warning'));

  // Start poller
  const pollerService = new PollerService();
  pollerService.setSocketServer(io);
  setAdoptionPoller(pollerService);
  setDevicesPoller(pollerService);
  setSystemPoller(pollerService);
  setSharedPollerService(pollerService);
  setBulkAddPollerService(pollerService);
  setTopologyPoller(pollerService);
  setClientsPoller(pollerService);
  await pollerService.start();

  // Trim job history left over from before retention limits existed. Runs in the
  // background: an installation with millions of retained jobs would otherwise
  // hold up startup, and nothing depends on it having finished.
  void pollerService.cleanupJobHistory().catch((e) =>
    console.error('[Poller] Job history cleanup failed:', e));

  // Pending work accumulated before dedup existed is dropped too, not just
  // finished-job history. An upgrade that leaves hundreds of thousands of stale
  // polls queued has not actually fixed anything the operator can see (#114).
  void pollerService.dropStalePending().catch((e) =>
    console.error('[Poller] Stale-pending sweep failed:', e));
  await startBulkAddWorker();
  await startSshKeyFleetWorker();

  // NetFlow/IPFIX collector (binds its UDP socket only when netflow_enabled)
  await netflowCollector.start();

  // Firmware rollout scheduler (starts rollouts whose scheduled_at has arrived)
  // Close out any rollout or command run left mid-flight by a previous process
  // (#140). Must happen before the scheduler starts, so a stale 'running' row
  // cannot block a due rollout from starting.
  await firmwareOrchestrator.reconcileInterrupted().catch((e: unknown) =>
    console.error('[Firmware] could not reconcile interrupted rollouts:', e));
  await commandRunner.reconcileInterrupted().catch((e: unknown) =>
    console.error('[Command] could not reconcile interrupted runs:', e));

  firmwareOrchestrator.startScheduler();
  startMirrorScheduler();

  // Scheduled report mailer (hourly check)
  reportService.startScheduler();

  // Start HTTP server. No host given, Node listens on :: (IPv4 and IPv6) where
  // the kernel has IPv6 and falls back to 0.0.0.0 where it doesn't (#231).
  // IPv4 peers then appear as ::ffff:a.b.c.d; clientIpBehindProxy and the audit
  // log strip that prefix.
  httpServer.listen(PORT, () => {
    console.log(`✓ Mikrotik Manager backend running on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await stopBulkAddWorker();
    await stopSshKeyFleetWorker();
    await netflowCollector.stop();
    await pollerService.stop();
    await redis.quit().catch(() => {});
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// A promise rejection nobody handled ends a Node process by default. One
// missed .catch() (a database restart under a background task, say) would then
// take down the API, every poll, and any rollout or bulk job in flight. Log it
// loudly instead, with enough to find the missing handler.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection] a promise failed with no handler:', err.stack || err.message);
});

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
