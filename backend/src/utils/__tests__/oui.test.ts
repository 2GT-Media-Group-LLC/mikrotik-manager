// Prevent any real HTTPS calls — all tests either use mocked fs cache or don't reach the download path
jest.mock('https', () => ({
  get: jest.fn((_url: string, _opts: unknown, _cb: unknown) => {
    const req = { on: jest.fn().mockReturnThis(), destroy: jest.fn() };
    return req;
  }),
}));

import { lookupVendor, initOuiDatabase } from '../oui';

describe('lookupVendor - before initialization', () => {
  it('returns empty string when database is not loaded', () => {
    // The module starts with db = null; lookupVendor returns '' immediately
    expect(lookupVendor('AA:BB:CC:DD:EE:FF')).toBe('');
  });
});

describe('lookupVendor - after initialization from cache', () => {
  // Build fake cache once (must be > 10,000 entries to pass the size check in _load)
  const fakeCache: Record<string, string> = { AABBCC: 'Test Vendor Inc' };
  for (let i = 0; i < 10001; i++) {
    const key = i.toString(16).padStart(6, '0').toUpperCase();
    if (!fakeCache[key]) fakeCache[key] = `Vendor ${i}`;
  }

  let lookup: (mac: string) => string;

  beforeEach(async () => {
    jest.resetModules();

    // The fresh-cache read opens the file once and checks age and content on
    // that handle (alert #98), so the handle-based calls are what is mocked.
    jest.doMock('fs', () => ({
      accessSync: () => undefined,           // data directory is writable
      constants: { W_OK: 2 },
      openSync: () => 3,
      fstatSync: () => ({ mtimeMs: Date.now() - 1000 }),
      closeSync: jest.fn(),
      statSync: () => ({ mtimeMs: Date.now() - 1000 }),
      readFileSync: () => JSON.stringify(fakeCache),
      writeFileSync: jest.fn(),
      existsSync: () => true,
      mkdirSync: jest.fn(),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../oui') as { initOuiDatabase: () => Promise<void>; lookupVendor: (mac: string) => string };
    await mod.initOuiDatabase();
    lookup = mod.lookupVendor;
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('finds a known vendor', () => {
    expect(lookup('AABBCC')).toBe('Test Vendor Inc');
  });

  it('normalizes colon separators (AA:BB:CC:DD:EE:FF)', () => {
    expect(lookup('AA:BB:CC:DD:EE:FF')).toBe('Test Vendor Inc');
  });

  it('normalizes dash separators (AA-BB-CC-DD-EE-FF)', () => {
    expect(lookup('AA-BB-CC-DD-EE-FF')).toBe('Test Vendor Inc');
  });

  it('normalizes dot separators (AABB.CCDD.EEFF)', () => {
    expect(lookup('AABB.CCDD.EEFF')).toBe('Test Vendor Inc');
  });

  it('is case-insensitive', () => {
    expect(lookup('aa:bb:cc:dd:ee:ff')).toBe('Test Vendor Inc');
  });

  it('returns empty string for an unknown MAC', () => {
    expect(lookup('FF:FF:FF:FF:FF:FF')).toBe('');
  });
});

// Verify that initOuiDatabase only runs _load once (singleton promise)
describe('initOuiDatabase - singleton', () => {
  it('returns the same promise on repeated calls', () => {
    const p1 = initOuiDatabase();
    const p2 = initOuiDatabase();
    expect(p1).toBe(p2);
  });
});

describe('cache location (#101)', () => {
  afterEach(() => jest.resetModules());

  it('never falls back to a fixed name in /tmp when the data directory is not writable', async () => {
    jest.resetModules();
    const opened: string[] = [];
    const written: string[] = [];
    jest.doMock('fs', () => ({
      accessSync: () => { throw new Error('EACCES'); },
      constants: { W_OK: 2 },
      openSync: (p: string) => { opened.push(p); throw new Error('ENOENT'); },
      readFileSync: (p: string) => { opened.push(String(p)); throw new Error('ENOENT'); },
      writeFileSync: (p: string) => { written.push(p); },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../oui') as { initOuiDatabase: (allowDownload?: boolean) => Promise<void> };
    await mod.initOuiDatabase(false);
    expect(opened.filter((p) => p.startsWith('/tmp'))).toEqual([]);
    expect(written).toEqual([]);
  });
});
