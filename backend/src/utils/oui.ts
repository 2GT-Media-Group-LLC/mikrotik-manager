/**
 * Local IEEE OUI database lookup.
 * Downloads the official IEEE MA-L CSV on first use, caches it for 30 days,
 * then serves all vendor lookups from memory — no rate limits, no external calls
 * per client.
 */
import https from 'https';
import fs from 'fs';
import path from 'path';

/**
 * Kept on the persistent app_data volume rather than in /tmp.
 *
 * /tmp is inside the container, so every upgrade — which recreates it — threw
 * the cache away. That was a slow re-download for most installs; for a dark site
 * with the download turned off it meant vendor lookups went empty after every
 * upgrade and never came back. /tmp remains the fallback where /app/data is not
 * writable.
 */
function resolveCacheFile(): string {
  const dir = process.env.SECRETS_DIR || '/app/data';
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return path.join(dir, 'oui-ieee.json');
  } catch {
    return '/tmp/oui-ieee.json';
  }
}
const CACHE_FILE = resolveCacheFile();
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const IEEE_CSV_URL = 'https://standards-oui.ieee.org/oui/oui.csv';

let db: Map<string, string> | null = null;
let initPromise: Promise<void> | null = null;

/**
 * @param allowDownload  false on a dark site: use whatever copy is on disk,
 *   however old, and never contact the IEEE.
 */
export function initOuiDatabase(allowDownload = true): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = _load(allowDownload);
  return initPromise;
}

export function lookupVendor(mac: string): string {
  if (!db) return '';
  const oui = mac.replace(/[:\-.]/g, '').substring(0, 6).toUpperCase();
  return db.get(oui) ?? '';
}

/**
 * Read the cached copy regardless of age. An out-of-date vendor list is far more
 * useful than none, and on a dark site it may be the only one there will ever
 * be. Previously a failed download discarded it and left lookups empty.
 */
function _readStaleCache(): Map<string, string> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Record<string, string>;
    const map = new Map(Object.entries(raw));
    return map.size > 10_000 ? map : null;
  } catch {
    return null;
  }
}

async function _load(allowDownload: boolean): Promise<void> {
  // Try valid cache first
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Record<string, string>;
      const map = new Map(Object.entries(raw));
      if (map.size > 10_000) {
        db = map;
        console.log(`OUI database loaded from cache: ${db.size} entries`);
        return;
      }
    }
  } catch { /* cache miss */ }

  if (!allowDownload) {
    const stale = _readStaleCache();
    db = stale ?? new Map();
    console.log(stale
      ? `OUI: download disabled (Dark Site Mode); using cached copy, ${db.size} entries`
      : 'OUI: download disabled (Dark Site Mode) and no cached copy; vendor lookups will be empty');
    return;
  }

  // Download fresh from IEEE
  try {
    console.log('Downloading IEEE OUI database…');
    const csv = await _fetch(IEEE_CSV_URL);
    const map = _parseCsv(csv);
    if (map.size > 10_000) {
      db = map;
      console.log(`OUI database downloaded: ${db.size} entries`);
      // Persist cache
      const obj: Record<string, string> = {};
      for (const [k, v] of map) obj[k] = v;
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
    } else {
      console.warn('OUI: Downloaded file too small, ignoring');
      db = new Map();
    }
  } catch (err) {
    const stale = _readStaleCache();
    db = stale ?? new Map();
    console.warn(stale
      ? `OUI: Download failed (${(err as Error).message}); using older cached copy, ${db.size} entries`
      : `OUI: Download failed (${(err as Error).message}). Vendor lookups will be empty.`);
  }
}

function _parseCsv(csv: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of csv.split('\n')) {
    // IEEE CSV: Registry,Assignment,Organization Name,Organization Address
    // Quoted fields may contain commas, e.g. "Cisco Systems, Inc"
    const fields = _csvSplit(line);
    if (fields[0]?.trim() !== 'MA-L') continue;
    const oui  = fields[1]?.trim().toUpperCase();
    const name = fields[2]?.trim();
    if (oui?.length === 6 && name) map.set(oui, name);
  }
  return map;
}

function _csvSplit(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"')           { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else                      { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

function _fetch(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
