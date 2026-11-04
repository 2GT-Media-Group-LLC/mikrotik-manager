import { apiExport, apiExportSupported, spaceProblem, EXPORT_FILE, ApiExportError, type ApiFileClient } from '../apiExport';

const MiB = 1_048_576;

/** A device's file store and /export, as far as the API export uses them. */
function fakeDevice(opts: { config?: Buffer; free?: number; total?: number; files?: string[]; failRemove?: boolean; exportError?: string } = {}) {
  const config = opts.config ?? Buffer.from('# 2026-11-04 by RouterOS 7.25\n/interface bridge\nadd name=bridge\n');
  const files = new Map<string, Buffer>((opts.files ?? []).map((n) => [n, Buffer.from('old')]));
  const calls: { command: string; params?: Record<string, string> }[] = [];
  const client: ApiFileClient = {
    async execute(command, params = {}, queries = []) {
      calls.push({ command, params });
      if (command === '/system/resource/print') {
        return [{ 'free-hdd-space': String(opts.free ?? 60 * MiB), 'total-hdd-space': String(opts.total ?? 128 * MiB) }];
      }
      if (command === '/export') {
        if (opts.exportError) throw new Error(opts.exportError);
        files.set(`${params.file}.rsc`, config);
        return [];
      }
      if (command === '/file/print') {
        const want = queries.find((q) => q.startsWith('?name='))?.slice(6);
        return [...files.entries()].filter(([n]) => !want || n === want).map(([name, b]) => ({ name, size: String(b.length) }));
      }
      if (command === '/file/remove') {
        if (opts.failRemove) throw new Error('failure');
        files.delete(params.numbers);
        return [];
      }
      throw new Error(`no such command ${command}`);
    },
    async readFileChunk(file, offset, chunkSize) {
      calls.push({ command: '/file/read', params: { file, offset: String(offset), 'chunk-size': String(chunkSize) } });
      return (files.get(file) ?? Buffer.alloc(0)).subarray(offset, offset + chunkSize);
    },
  };
  return { client, files, calls };
}

describe('apiExport (#392)', () => {
  it('exports, reads the file back in 32 KiB chunks and removes it', async () => {
    // A multi-byte character split by the 32 KiB boundary comes back whole.
    const config = Buffer.concat([Buffer.from('#'.repeat(32_767)), Buffer.from('é comment\n'), Buffer.from('x'.repeat(40_000))]);
    const d = fakeDevice({ config });
    const text = await apiExport(d.client, { showSensitive: false });
    expect(Buffer.from(text, 'utf8').equals(config)).toBe(true);
    expect(d.calls.filter((c) => c.command === '/file/read')).toHaveLength(3);
    expect(d.files.size).toBe(0);
    expect(d.calls.find((c) => c.command === '/export')?.params).not.toHaveProperty('show-sensitive');
  });

  it('asks for passwords and keys only when told to', async () => {
    const d = fakeDevice();
    await apiExport(d.client, { showSensitive: true });
    expect(d.calls.find((c) => c.command === '/export')?.params).toHaveProperty('show-sensitive', '');
  });

  it('removes what an earlier run left behind, and nothing else', async () => {
    const d = fakeDevice({ files: ['mtm-backup-0123456789ab.rsc', 'mtm-backup-notes.rsc', 'backup.rsc', 'flash/mtm-backup-0123456789ab.rsc'] });
    await apiExport(d.client, { showSensitive: false });
    expect([...d.files.keys()].sort()).toEqual(['backup.rsc', 'flash/mtm-backup-0123456789ab.rsc', 'mtm-backup-notes.rsc']);
    expect(EXPORT_FILE.test('mtm-backup-0123456789ab.rsc')).toBe(true);
  });

  it('writes nothing when the device is short of storage', async () => {
    const d = fakeDevice({ free: 1.5 * MiB, total: 16 * MiB });
    await expect(apiExport(d.client, { showSensitive: false, estimateBytes: 400 * 1024 })).rejects.toThrow(/storage is free/);
    expect(d.calls.some((c) => c.command === '/export')).toBe(false);
  });

  it('removes the file even when reading it fails, and explains old RouterOS', async () => {
    const d = fakeDevice();
    d.client.readFileChunk = async () => { throw new Error('no such command'); };
    await expect(apiExport(d.client, { showSensitive: false })).rejects.toThrow(/needs 7\.13 or later/);
    expect(d.files.size).toBe(0);
  });

  it('names missing permissions', async () => {
    const d = fakeDevice({ exportError: 'not enough permissions (9)' });
    await expect(apiExport(d.client, { showSensitive: false })).rejects.toThrow(/ftp and sensitive policies/);
  });

  it('does not fail a good export when the file could not be removed', async () => {
    const d = fakeDevice({ failRemove: true });
    await expect(apiExport(d.client, { showSensitive: false })).resolves.toContain('/interface bridge');
  });

  it('refuses a short read', async () => {
    const d = fakeDevice();
    d.client.readFileChunk = async () => Buffer.alloc(0);
    await expect(apiExport(d.client, { showSensitive: false })).rejects.toBeInstanceOf(ApiExportError);
    expect(d.files.size).toBe(0);
  });
});

describe('room for the export', () => {
  it('needs twice the expected size plus 1 MiB or 5 % of the disk', () => {
    expect(spaceProblem(60 * MiB, 128 * MiB, 512 * 1024)).toBeNull();
    // 16 MiB flash: 1 MiB reserve, so 100 KiB twice over plus 1 MiB fits in 1.5 MiB.
    expect(spaceProblem(1.5 * MiB, 16 * MiB, 100 * 1024)).toBeNull();
    expect(spaceProblem(1.1 * MiB, 16 * MiB, 100 * 1024)).toMatch(/only 1126 KiB/);
    // 1 GiB disk: 5 % kept free.
    expect(spaceProblem(40 * MiB, 1024 * MiB, 100 * 1024)).toMatch(/52429 KiB kept free/);
    expect(spaceProblem(NaN, 0, 1)).toMatch(/did not report/);
  });

  it('needs RouterOS 7.13 to read files over the API', () => {
    expect(apiExportSupported('7.13')).toBe(true);
    expect(apiExportSupported('7.25 (stable)')).toBe(true);
    expect(apiExportSupported('7.12.1')).toBe(false);
    expect(apiExportSupported('6.49.17')).toBe(false);
    expect(apiExportSupported(null)).toBe(true);
  });
});
