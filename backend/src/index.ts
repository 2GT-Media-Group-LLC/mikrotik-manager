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
import { verifyToken } from './middleware/auth';
import { decrypt } from './utils/crypto';
import { corsMiddlewareOptions, socketIoCorsOptions } from './utils/corsOrigins';

import authRoutes from './routes/auth';
import devicesRoutes, { setPollerService as setDevicesPoller } from './routes/devices';
import clientsRoutes, { setPollerService as setClientsPoller } from './routes/clients';
import eventsRoutes from './routes/events';
import backupsRoutes from './routes/backups';
import metricsRoutes from './routes/metrics';
import topologyRoutes, { setPollerService as setTopologyPoller } from './routes/topology';
import settingsRoutes from './routes/settings';
import certRoutes from './routes/cert';
import searchRoutes from './routes/search';
import switchesRoutes from './routes/switches';
import routersRoutes from './routes/routers';
import alertsRoutes from './routes/alerts';
import wirelessRoutes from './routes/wireless';
import networkServicesRoutes from './routes/networkServices';
import credentialPresetsRoutes from './routes/credentialPresets';

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

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ─── SSH Terminal namespace ────────────────────────────────────────────────────
const terminalNs = io.of('/terminal');

terminalNs.use((socket, next) => {
  const token = (socket.handshake.auth as { token?: string })?.token;
  if (!token) return next(new Error('No token'));
  try {
    verifyToken(token);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

terminalNs.on('connection', (socket) => {
  let sshClient: SshClient | null = null;
  let shellStream: ClientChannel | null = null;

  socket.on('start', async (payload: { deviceId: number; cols?: number; rows?: number }) => {
    const { deviceId, cols = 80, rows = 24 } = payload;
    try {
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

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/backups', backupsRoutes);
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
app.use('/api/credential-presets', credentialPresetsRoutes);

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Startup ─────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
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
  setBulkAddPollerService(pollerService);
  setTopologyPoller(pollerService);
  setClientsPoller(pollerService);
  await pollerService.start();
  await startBulkAddWorker();

  // Start HTTP server
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Mikrotik Manager backend running on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await stopBulkAddWorker();
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
