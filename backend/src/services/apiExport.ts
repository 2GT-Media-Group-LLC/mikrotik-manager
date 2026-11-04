import { randomBytes } from 'crypto';
import { compareRosVersions } from '../utils/rosVersion';

/**
 * Config export over the API, for devices with SSH off or refusing (#392).
 *
 * The API has no command that returns an export, but RouterOS 7.13 and later
 * can read a file back over it: `/export file=` writes the script to the
 * device's storage, `/file/read` returns it in chunks, and the file is removed.
 * On a TEST switch, a wAP ax and a CCR2216 the result was byte for byte the
 * SSH export.
 *
 * The file is written to the device's own storage, so the export only runs
 * when there's room for it with plenty to spare, and it's always removed,
 * along with any a failed run left behind.
 */

export interface ApiFileClient {
  execute(command: string, params?: Record<string, string>, queries?: string[], opts?: { timeoutMs?: number }): Promise<Record<string, string>[]>;
  readFileChunk(file: string, offset: number, chunkSize: number): Promise<Buffer>;
}

/** Our temporary files, and nothing else: only these are ever removed. */
export const EXPORT_FILE = /^mtm-backup-[0-9a-f]{12}\.rsc$/;
const CHUNK = 32_768;
const MiB = 1_048_576;
/** Assumed size of an export never taken before. Configurations are usually far smaller. */
export const DEFAULT_ESTIMATE = 512 * 1024;

export class ApiExportError extends Error {}

/** RouterOS reads files over the API from 7.13. An unknown version is tried. */
export function apiExportSupported(version: string | null | undefined): boolean {
  const v = (version ?? '').trim().split(/\s/)[0];
  if (!v) return true;
  return compareRosVersions(v, '7.13') >= 0;
}

/**
 * Why there isn't room for the export, or null. It needs twice the expected
 * size (the export can grow) and leaves at least 1 MiB, or 5 % of the disk if
 * that's more, free for RouterOS itself.
 */
export function spaceProblem(freeBytes: number, totalBytes: number, estimateBytes: number): string | null {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return 'the device did not report its free storage';
  const reserve = Math.max(MiB, Number.isFinite(totalBytes) ? totalBytes * 0.05 : 0);
  const need = estimateBytes * 2 + reserve;
  if (freeBytes >= need) return null;
  const kib = (n: number) => `${Math.round(n / 1024)} KiB`;
  return `only ${kib(freeBytes)} of storage is free, and exporting over the API needs ${kib(need)} `
    + `(twice the expected ${kib(estimateBytes)}, plus ${kib(reserve)} kept free)`;
}

/**
 * Export the configuration over the API and return the script. `showSensitive`
 * as for `/export show-sensitive` (RouterOS 7). Throws ApiExportError with a
 * reason a person can act on.
 */
export async function apiExport(client: ApiFileClient, opts: { showSensitive: boolean; estimateBytes?: number }): Promise<string> {
  // Anything a failed run left behind goes first: it holds a configuration,
  // and it takes the room this run needs.
  const files = await client.execute('/file/print').catch(() => [] as Record<string, string>[]);
  for (const f of files) {
    const name = f['name'] ?? '';
    if (EXPORT_FILE.test(name)) await client.execute('/file/remove', { numbers: name }).catch(() => {});
  }

  const [res] = await client.execute('/system/resource/print');
  const problem = spaceProblem(Number(res?.['free-hdd-space']), Number(res?.['total-hdd-space']), opts.estimateBytes ?? DEFAULT_ESTIMATE);
  if (problem) throw new ApiExportError(`Not exported over the API: ${problem}.`);

  const base = `mtm-backup-${randomBytes(6).toString('hex')}`;
  const file = `${base}.rsc`;
  try {
    // A large configuration takes a while to export, as over SSH.
    await client.execute('/export', { file: base, ...(opts.showSensitive ? { 'show-sensitive': '' } : {}) }, [], { timeoutMs: 10 * 60_000 });
    const [entry] = await client.execute('/file/print', {}, [`?name=${file}`]);
    const size = Number(entry?.['size']);
    if (!entry || !Number.isFinite(size)) throw new ApiExportError('The export file did not appear on the device.');
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < size) {
      const chunk = await client.readFileChunk(file, offset, CHUNK);
      if (chunk.length === 0) break;
      parts.push(chunk);
      offset += chunk.length;
    }
    if (offset !== size) throw new ApiExportError(`Read ${offset} of the export's ${size} bytes.`);
    return Buffer.concat(parts).toString('utf8');
  } catch (e) {
    if (e instanceof ApiExportError) throw e;
    const msg = (e as Error).message ?? String(e);
    throw new ApiExportError(/no such command/i.test(msg)
      ? 'This RouterOS can’t read files over the API (it needs 7.13 or later).'
      : /permission|not allowed|policy/i.test(msg)
        ? `The API user isn’t allowed to export or read files (${msg}); it needs the read, write, ftp and sensitive policies.`
        : `Exporting over the API failed: ${msg}`, { cause: e });
  } finally {
    await client.execute('/file/remove', { numbers: file }).catch(() => {
      console.warn(`[Backup] could not remove ${file} from the device; the next backup removes it`);
    });
  }
}
