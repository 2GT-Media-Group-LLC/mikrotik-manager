import { Queue, Worker, Job } from 'bullmq';
import { createRedisConnection, redis } from '../config/redis';
import { query, queryOne } from '../config/database';
import { classifyKeyTarget } from '../utils/sshKeyCredentials';
import { sshKeyService, SSH_TARGET_COLS, type SshTarget } from './SshKeyService';

/**
 * Fleet-wide SSH key deployment as a background job.
 *
 * The earlier POST /devices/ssh-keys/deploy-all did every device inside one
 * HTTP request. At a few seconds per device, a 500-device fleet ran far past
 * any proxy timeout, and the only alternative in the UI was keying devices one
 * at a time.
 *
 * Deliberately conservative:
 *   - sequential, one device at a time (each deployment opens two SSH sessions
 *     and proves the key on a fresh one)
 *   - every device is re-checked when reached, not trusted from the preview
 *   - the run stops after HALT_AFTER consecutive failures, which usually means
 *     something fleet-wide is wrong (SSH service off, wrong password everywhere)
 *   - one audit_log row per device, so every key install can be traced
 * A failed deployment removes the key it installed (SshKeyService.deploy), so
 * failures leave devices as they were.
 */

const QUEUE_NAME = 'ssh-key-fleet';
const TTL_SEC = 86400;
export const HALT_AFTER = 5;

export interface FleetKeyResult {
  device_id: number;
  name: string;
  outcome: 'keyed' | 'failed' | 'skipped';
  username?: string;
  source?: 'ssh' | 'api';
  message: string;
}

interface Payload {
  jobId: string;
  deviceIds: number[];
  userId: number | null;
  username: string | null;
}

const k = (jobId: string, part: 'meta' | 'results' | 'cancel') => `ssh-key-fleet:${jobId}:${part}`;

let queue: Queue | null = null;
let worker: Worker | null = null;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await redis.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

async function writeMeta(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const cur = await readJson<Record<string, unknown>>(k(jobId, 'meta'), {});
  await redis.set(k(jobId, 'meta'), JSON.stringify({ ...cur, ...patch }), 'EX', TTL_SEC);
}

async function appendResult(jobId: string, row: FleetKeyResult): Promise<void> {
  const cur = await readJson<FleetKeyResult[]>(k(jobId, 'results'), []);
  await redis.set(k(jobId, 'results'), JSON.stringify([...cur, row]), 'EX', TTL_SEC);
}

export async function initFleetKeyJob(jobId: string, total: number, ownerUserId: number): Promise<void> {
  await redis.set(k(jobId, 'meta'), JSON.stringify({
    status: 'queued', total, processed: 0, keyed: 0, failed: 0, skipped: 0,
    owner_user_id: ownerUserId, created_at: new Date().toISOString(),
  }), 'EX', TTL_SEC);
  await redis.set(k(jobId, 'results'), '[]', 'EX', TTL_SEC);
}

async function audit(p: Payload, deviceId: number, summary: string, ok: boolean): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, username, method, path, entity_type, entity_id, summary, ip_address, status_code)
     VALUES ($1,$2,'JOB',$3,'device',$4,$5,NULL,$6)`,
    [p.userId, p.username, `/api/ssh-keys/fleet/jobs/${p.jobId}`, deviceId, summary.slice(0, 500), ok ? 200 : 502]
  ).catch(() => {});
}

async function processJob(job: Job<Payload>): Promise<void> {
  const p = job.data;
  const { jobId, deviceIds } = p;
  await writeMeta(jobId, { status: 'active', started_at: new Date().toISOString() });
  const counts = { keyed: 0, failed: 0, skipped: 0 };
  let consecutiveFailures = 0;

  for (let i = 0; i < deviceIds.length; i++) {
    if (await redis.get(k(jobId, 'cancel'))) {
      await writeMeta(jobId, { status: 'cancelled', processed: i, current_name: null, finished_at: new Date().toISOString() });
      return;
    }

    const row = await queryOne<SshTarget & { status: string; has_verified_key: boolean }>(
      `SELECT ${SSH_TARGET_COLS}, status,
              EXISTS (SELECT 1 FROM device_ssh_keys k WHERE k.device_id = devices.id AND k.status = 'verified')
                AS has_verified_key
         FROM devices WHERE id = $1`,
      [deviceIds[i]]
    );
    await writeMeta(jobId, { processed: i, current_name: row?.name ?? null });

    let result: FleetKeyResult;
    if (!row) {
      result = { device_id: deviceIds[i], name: `#${deviceIds[i]}`, outcome: 'skipped', message: 'Device no longer exists.' };
    } else {
      const c = classifyKeyTarget(row);
      if (c.kind === 'keyed') {
        result = { device_id: row.id, name: row.name, outcome: 'skipped', message: 'Already has a verified key.' };
      } else if (c.kind === 'skip') {
        result = { device_id: row.id, name: row.name, outcome: 'skipped', message: c.reason };
      } else {
        try {
          await sshKeyService.deploy(row);
          result = { device_id: row.id, name: row.name, outcome: 'keyed', username: c.username, source: c.source,
            message: `Key installed and verified for "${c.username}".` };
        } catch (e) {
          result = { device_id: row.id, name: row.name, outcome: 'failed', username: c.username, source: c.source,
            message: (e as Error).message };
        }
        await audit(p, row.id,
          result.outcome === 'keyed'
            ? `Fleet SSH key job: key installed for user ${c.username} (${c.source === 'api' ? 'API login' : 'SSH login'})`
            : `Fleet SSH key job: failed for user ${c.username}: ${result.message}`,
          result.outcome === 'keyed');
      }
    }

    counts[result.outcome === 'keyed' ? 'keyed' : result.outcome === 'failed' ? 'failed' : 'skipped']++;
    await appendResult(jobId, result);
    await writeMeta(jobId, { processed: i + 1, ...counts });

    consecutiveFailures = result.outcome === 'failed' ? consecutiveFailures + 1 : result.outcome === 'keyed' ? 0 : consecutiveFailures;
    if (consecutiveFailures >= HALT_AFTER) {
      await writeMeta(jobId, {
        status: 'halted', current_name: null, finished_at: new Date().toISOString(),
        error: `Stopped after ${HALT_AFTER} failures in a row. That usually means something fleet-wide ` +
               '(SSH turned off, a firewall, a wrong password). The remaining devices were not touched.',
      });
      return;
    }
  }

  await writeMeta(jobId, { status: 'completed', processed: deviceIds.length, current_name: null, finished_at: new Date().toISOString() });
}

export async function enqueueFleetKeyJob(payload: Payload): Promise<void> {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: createRedisConnection() });
  await queue.add('run', payload, { attempts: 1, removeOnComplete: { age: 3600, count: 50 }, removeOnFail: { age: 86400 } });
}

export async function getFleetKeyJob(jobId: string) {
  const meta = await readJson<Record<string, unknown>>(k(jobId, 'meta'), {});
  if (!Object.keys(meta).length) return null;
  return { meta, results: await readJson<FleetKeyResult[]>(k(jobId, 'results'), []) };
}

export async function cancelFleetKeyJob(jobId: string): Promise<void> {
  await redis.set(k(jobId, 'cancel'), '1', 'EX', TTL_SEC);
}

export async function startSshKeyFleetWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker<Payload>(QUEUE_NAME, async (job) => {
    try {
      await processJob(job);
    } catch (err) {
      console.error('[SshKeyFleet] job failed:', job.id, err);
      await writeMeta(job.data.jobId, { status: 'failed', error: 'The job stopped unexpectedly. Check the server logs.' });
      throw err;
    }
  }, { connection: createRedisConnection(), concurrency: 1 });
}

export async function stopSshKeyFleetWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
