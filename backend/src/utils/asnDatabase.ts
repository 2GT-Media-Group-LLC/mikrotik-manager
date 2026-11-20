/**
 * Who owns an IP address: its autonomous system (ASN), organisation and
 * country, from the iptoasn.com database (public domain, PDDL). Used to name
 * traffic destinations, so 142.250.x.x reads as Google (#366).
 *
 * A copy is built into the image. A newer one is downloaded weekly to the
 * app_data volume unless Dark Site Mode turns that off, and whichever copy is
 * newer is used. Lookups are served from memory: about 600,000 ranges, held
 * in typed arrays (roughly 15 MB) rather than objects.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import zlib from 'zlib';
import net from 'net';
import { logSafe } from './logSafe';

export const ASN_URL = 'https://iptoasn.com/data/ip2asn-combined.tsv.gz';
const FILE_NAME = 'ip2asn-combined.tsv.gz';
/** Refreshed when the copy in use is older than this. */
export const ASN_MAX_AGE_MS = 7 * 86_400_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export interface AsnInfo {
  asn: number;
  org: string;
  country: string;
}

/** What an address is, when it isn't on the public internet. */
export type SpecialKind = 'private' | 'loopback' | 'link-local' | 'multicast' | 'cgnat' | 'reserved';

export interface AsnTable {
  v4Start: Uint32Array;
  v4End: Uint32Array;
  v4Asn: Uint32Array;
  /** IPv6 ranges as two 64-bit halves each. */
  v6StartHi: BigUint64Array;
  v6StartLo: BigUint64Array;
  v6EndHi: BigUint64Array;
  v6EndLo: BigUint64Array;
  v6Asn: Uint32Array;
  orgs: Map<number, { org: string; country: string }>;
  /** When the data was published (the file's modification time). */
  builtAt: Date;
}

// ─── Address helpers ─────────────────────────────────────────────────────────

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** An IPv6 address as [high 64 bits, low 64 bits], or null. */
export function ipv6ToHalves(ip: string): [bigint, bigint] | null {
  if (!net.isIPv6(ip)) return null;
  let s = ip.split('%')[0];
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t];
  if (groups.length !== 8) return null;
  let hi = 0n, lo = 0n;
  for (let i = 0; i < 8; i++) {
    const g = BigInt(parseInt(groups[i] || '0', 16));
    if (i < 4) hi = (hi << 16n) | g; else lo = (lo << 16n) | g;
  }
  return [hi, lo];
}

/** Addresses that aren't anyone's on the internet, named for what they are. */
export function specialKind(ip: string): SpecialKind | null {
  const n = ipv4ToInt(ip);
  if (n !== null) {
    const a = n >>> 24, b = (n >>> 16) & 0xff;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
    if (a >= 224 && a <= 239) return 'multicast';
    if (a === 0 || a >= 240) return 'reserved';
    return null;
  }
  const v6 = ipv6ToHalves(ip);
  if (!v6) return null;
  const [hi, lo] = v6;
  if (hi === 0n && lo === 1n) return 'loopback';
  if (hi === 0n && (lo >> 32n) === 0xffffn) return specialKind(intToIpv4(Number(lo & 0xffffffffn)));
  const top16 = hi >> 48n;
  if ((top16 & 0xfe00n) === 0xfc00n) return 'private';      // fc00::/7
  if ((top16 & 0xffc0n) === 0xfe80n) return 'link-local';   // fe80::/10
  if ((top16 & 0xff00n) === 0xff00n) return 'multicast';    // ff00::/8
  return null;
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** "GOOGLE - Google LLC" reads as "Google LLC"; a description without the handle stays as it is. */
export function displayOrg(description: string): string {
  const d = description.replace(/\r$/, '').trim();
  const i = d.indexOf(' - ');
  return (i > 0 && i < d.length - 3 ? d.slice(i + 3) : d).slice(0, 120);
}

/** Build the lookup table from the TSV text: start, end, ASN, country, description. */
export function parseAsnTsv(text: string, builtAt = new Date()): AsnTable {
  const v4: Array<[number, number, number]> = [];
  const v6: Array<[bigint, bigint, bigint, bigint, number]> = [];
  const orgs = new Map<number, { org: string; country: string }>();
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    const line = text.slice(pos, nl);
    pos = nl + 1;
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 5) continue;
    const asn = Number(f[2]);
    // AS 0 is "not routed": no owner to name.
    if (!Number.isInteger(asn) || asn <= 0) continue;
    if (!orgs.has(asn)) orgs.set(asn, { org: displayOrg(f[4]), country: f[3].slice(0, 2) });
    if (f[0].includes(':')) {
      const s = ipv6ToHalves(f[0]), e = ipv6ToHalves(f[1]);
      if (s && e) v6.push([s[0], s[1], e[0], e[1], asn]);
    } else {
      const s = ipv4ToInt(f[0]), e = ipv4ToInt(f[1]);
      if (s !== null && e !== null) v4.push([s, e, asn]);
    }
  }
  v4.sort((x, y) => x[0] - y[0]);
  v6.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) : x[0] < y[0] ? -1 : 1));
  const t: AsnTable = {
    v4Start: new Uint32Array(v4.length), v4End: new Uint32Array(v4.length), v4Asn: new Uint32Array(v4.length),
    v6StartHi: new BigUint64Array(v6.length), v6StartLo: new BigUint64Array(v6.length),
    v6EndHi: new BigUint64Array(v6.length), v6EndLo: new BigUint64Array(v6.length), v6Asn: new Uint32Array(v6.length),
    orgs, builtAt,
  };
  v4.forEach(([s, e, a], i) => { t.v4Start[i] = s; t.v4End[i] = e; t.v4Asn[i] = a; });
  v6.forEach(([sh, sl, eh, el, a], i) => { t.v6StartHi[i] = sh; t.v6StartLo[i] = sl; t.v6EndHi[i] = eh; t.v6EndLo[i] = el; t.v6Asn[i] = a; });
  return t;
}

const le = (ah: bigint, al: bigint, bh: bigint, bl: bigint) => ah < bh || (ah === bh && al <= bl);

/** The owner of a public address in this table, or null. */
export function lookupIn(t: AsnTable, ip: string): AsnInfo | null {
  let asn = 0;
  const n = ipv4ToInt(ip);
  if (n !== null) {
    let lo = 0, hi = t.v4Start.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (t.v4Start[mid] <= n) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found >= 0 && n <= t.v4End[found]) asn = t.v4Asn[found];
  } else {
    const v6 = ipv6ToHalves(ip);
    if (!v6) return null;
    const [h, l] = v6;
    let lo = 0, hi = t.v6StartHi.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (le(t.v6StartHi[mid], t.v6StartLo[mid], h, l)) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found >= 0 && le(h, l, t.v6EndHi[found], t.v6EndLo[found])) asn = t.v6Asn[found];
  }
  if (!asn) return null;
  const o = t.orgs.get(asn);
  return { asn, org: o?.org ?? `AS${asn}`, country: o?.country ?? '' };
}

// ─── Loading and refreshing ──────────────────────────────────────────────────

let table: AsnTable | null = null;
let loading: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;

const bundledFile = () => process.env.ASN_BUNDLED_FILE || '/app/asn/' + FILE_NAME;
function cacheFile(): string | null {
  const dir = process.env.SECRETS_DIR || '/app/data';
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return path.join(dir, FILE_NAME);
  } catch {
    return null;
  }
}

/** The newest readable copy and its age, preferring the downloaded one on a tie. */
function newestCopy(): { file: string; mtime: number } | null {
  const copies: Array<{ file: string; mtime: number }> = [];
  for (const file of [cacheFile(), bundledFile()]) {
    if (!file) continue;
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 1000) copies.push({ file, mtime: st.mtimeMs });
    } catch { /* missing */ }
  }
  copies.sort((a, b) => b.mtime - a.mtime);
  return copies[0] ?? null;
}

function loadFile(file: string, mtime: number): AsnTable {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const t = parseAsnTsv(text, new Date(mtime));
  if (t.v4Start.length < 10_000) throw new Error(`${file} has too few ranges (${t.v4Start.length})`);
  return t;
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const req = https.get(url, { timeout: 60_000, headers: { 'User-Agent': 'MikroTik-Manager' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let size = 0;
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) { req.destroy(new Error('download too large')); out.destroy(); }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close();
        try {
          // Checked before it replaces the copy in use: a truncated or bad file is thrown away.
          loadFile(tmp, Date.now());
          fs.renameSync(tmp, dest);
          resolve();
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          reject(e);
        }
      });
      out.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
  });
}

async function loadNewest(): Promise<void> {
  const copy = newestCopy();
  if (!copy) return;
  if (table && table.builtAt.getTime() >= copy.mtime) return;
  try {
    table = loadFile(copy.file, copy.mtime);
    lastError = null;
    console.log(`[ASN] Loaded ${table.v4Start.length + table.v6StartHi.length} ranges from ${copy.file}`);
  } catch (e) {
    lastError = (e as Error).message;
    console.warn(`[ASN] Could not load ${copy.file}: ${lastError}`);
  }
}

async function refresh(allowDownload: () => Promise<boolean>): Promise<void> {
  await loadNewest();
  const copy = newestCopy();
  const stale = !copy || Date.now() - copy.mtime > ASN_MAX_AGE_MS;
  const dest = cacheFile();
  if (!stale || !dest || !(await allowDownload())) return;
  try {
    await download(ASN_URL, dest);
    await loadNewest();
  } catch (e) {
    lastError = `download failed: ${(e as Error).message}`;
    console.warn('[ASN] %s', logSafe(lastError));
  }
}

/**
 * Load the newest copy, then download a fresh one when it's over a week old
 * and `allowDownload` says the internet may be used (Dark Site Mode). Checks
 * again every day. Doesn't block: lookups return null until a copy is loaded.
 */
export function startAsnDatabase(allowDownload: () => Promise<boolean>): void {
  if (loading) return;
  loading = refresh(allowDownload).catch(() => {});
  refreshTimer = setInterval(() => { void refresh(allowDownload); }, 86_400_000);
  refreshTimer.unref?.();
}

/** The owner of an address, or null when it's unknown or not public. */
export function lookupAsn(ip: string): AsnInfo | null {
  return table ? lookupIn(table, ip) : null;
}

/** For the settings page: whether names are available and how old they are. */
export function asnStatus(): { loaded: boolean; ranges: number; builtAt: string | null; error: string | null } {
  return {
    loaded: !!table,
    ranges: table ? table.v4Start.length + table.v6StartHi.length : 0,
    builtAt: table ? table.builtAt.toISOString() : null,
    error: lastError,
  };
}

/** For tests. */
export function setAsnTableForTest(t: AsnTable | null): void {
  table = t;
}
