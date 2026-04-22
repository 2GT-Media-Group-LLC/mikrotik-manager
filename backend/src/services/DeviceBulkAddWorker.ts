import { Queue, Worker, Job } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { redis } from '../config/redis';
import { createDeviceFromBody, type CreateDeviceInput } from './deviceCreation';
import type { PollerService } from './PollerService';

const QUEUE_NAME = 'bulk-add-devices';
const JOB_TTL_SEC = 86400;

let pollerService: PollerService | null = null;
let queue: Queue | null = null;
let worker: Worker | null = null;

export function setBulkAddPollerService(p: PollerService): void {
  pollerService = p;
}

function metaKey(jobId: string): string {
  return `device-bulk-add:${jobId}:meta`;
}

function resultsKey(jobId: string): string {
  return `device-bulk-add:${jobId}:results`;
}

export type BulkAddResultRow = {
  ip: string;
  identity: string;
  ok: boolean;
  message: string;
};

interface BulkJobPayload {
  jobId: string;
  items: CreateDeviceInput[];
}

async function readMeta(jobId: string): Promise<Record<string, unknown>> {
  const raw = await redis.get(metaKey(jobId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeMeta(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const cur = await readMeta(jobId);
  const next = { ...cur, ...patch };
  await redis.set(metaKey(jobId), JSON.stringify(next), 'EX', JOB_TTL_SEC);
}

async function readResults(jobId: string): Promise<BulkAddResultRow[]> {
  const raw = await redis.get(resultsKey(jobId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as BulkAddResultRow[];
  } catch {
    return [];
  }
}

async function appendResults(jobId: string, rows: BulkAddResultRow[]): Promise<void> {
  const cur = await readResults(jobId);
  const next = [...cur, ...rows];
  await redis.set(resultsKey(jobId), JSON.stringify(next), 'EX', JOB_TTL_SEC);
}

async function processJob(job: Job<BulkJobPayload>): Promise<void> {
  const { jobId, items } = job.data;
  await writeMeta(jobId, { status: 'active', processed: 0 });
  const poller = pollerService;

  for (let i = 0; i < items.length; i++) {
    const cancel = await redis.get(`device-bulk-add:${jobId}:cancel`);
    if (cancel) {
      await writeMeta(jobId, {
        status: 'cancelled',
        processed: i,
        current_name: null,
        cancelled_at: new Date().toISOString(),
      });
      return;
    }

    const item = items[i];
    const identity = item.name || item.ip_address || '';
    await writeMeta(jobId, {
      processed: i,
      current_name: identity,
    });

    const result = await createDeviceFromBody(
      {
        ...item,
        device_type: item.device_type || 'router',
      },
      poller
    );

    let failMsg = 'Failed';
    if (!result.ok) {
      const b = result.body;
      if (b.code === 'duplicate_serial') {
        failMsg = 'Duplicate serial — review manually before combining';
      } else if (typeof b.error === 'string') {
        failMsg = b.error;
      }
    }
    const row: BulkAddResultRow = {
      ip: item.ip_address || '',
      identity,
      ok: result.ok,
      message: result.ok
        ? (result.body.merged_from_duplicate ? 'Updated (duplicate serial)' : 'Added')
        : failMsg,
    };
    await appendResults(jobId, [row]);
    await writeMeta(jobId, { processed: i + 1 });
  }

  await writeMeta(jobId, {
    status: 'completed',
    processed: items.length,
    current_name: null,
    completed_at: new Date().toISOString(),
  });
}

export async function enqueueBulkAddJob(jobId: string, items: CreateDeviceInput[]): Promise<void> {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, { connection: createRedisConnection() });
  }
  await queue.add('run', { jobId, items } satisfies BulkJobPayload, {
    attempts: 1,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86400 },
  });
}

export async function getBulkAddJobState(jobId: string): Promise<{
  found: boolean;
  meta: Record<string, unknown>;
  results: BulkAddResultRow[];
}> {
  const meta = await readMeta(jobId);
  if (!meta || Object.keys(meta).length === 0) {
    return { found: false, meta: {}, results: [] };
  }
  const results = await readResults(jobId);
  return { found: true, meta, results };
}

export async function startBulkAddWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker<BulkJobPayload>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processJob(job);
      } catch (err) {
        const { jobId } = job.data;
        console.error('[BulkAddWorker] job failed:', job?.id, err);
        await writeMeta(jobId, {
          status: 'failed',
          error: 'Batch job failed. Check server logs for details.',
          failed_at: new Date().toISOString(),
        });
        throw err;
      }
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );
  worker.on('failed', (job, err) => {
    console.error('[BulkAddWorker] job failed:', job?.id, err);
  });
}

export async function stopBulkAddWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
