import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The text of the call or object literal starting at `open` (a '(' or '{'), brackets balanced. */
function balanced(src: string, open: number): string {
  const close = src[open] === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

/**
 * Files that open sockets or HTTP requests of their own, and why each is
 * allowed to. Anything else doing so would skip a device's route.
 */
const OWN_CONNECTIONS = new Map([
  ['services/mikrotik/RouterOSClient.ts', 'the API connection itself: direct, or over the channel its jump host opened'],
  ['services/wwwSsl.ts', "the WebFig check, over the device's jump host when it has one"],
  ['services/jumpHosts.ts', 'the SSH connection to the jump host itself'],
  ['services/firmwareMirror.ts', 'downloads from mikrotik.com only'],
  ['utils/oui.ts', 'the IEEE vendor list'],
  ['routes/clients.ts', 'a Wake-on-LAN broadcast, not a connection to a device'],
  ['services/netflow/NetflowCollector.ts', 'listens for flows the devices send'],
]);

/**
 * A device behind a jump host must never be contacted directly (#jump-hosts).
 * Every connection to a managed device names its route, and a forgotten one
 * defaults to direct, so the rule is checked here rather than trusted: each
 * RouterOSClient is given a route, and each device SSH connection that checks
 * the host key also spreads in the forwarded channel.
 */
describe('every device connection names its route', () => {
  const files = sourceFiles(SRC).map((f) => ({ file: relative(SRC, f), src: readFileSync(f, 'utf8') }));

  it('passes a route to every RouterOSClient', () => {
    const missing: string[] = [];
    for (const { file, src } of files) {
      const re = /new RouterOSClient\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const args = balanced(src, re.lastIndex - 1);
        if (/routeOf\(|jumpHostId|jump_host_id|\bvia\b/.test(args)) continue;
        missing.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('spreads the forwarded channel into every device SSH connection', () => {
    const missing: string[] = [];
    for (const { file, src } of files) {
      const re = /\.connect\(\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const opts = balanced(src, re.lastIndex - 1);
        // Device connections are the ones that check the device's host key.
        if (!opts.includes('sshHostCheck(')) continue;
        if (/\.\.\.(route|sshRouteOpts)\b|sshRoute\(/.test(opts)) continue;
        missing.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('opens no sockets or HTTP requests anywhere else', () => {
    const found: string[] = [];
    for (const { file, src } of files) {
      if (OWN_CONNECTIONS.has(file)) continue;
      const re = /\b(?:net\.(?:connect|createConnection)|tls\.connect|https?\.(?:request|get)|dgram\.createSocket)\(|new net\.Socket\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) found.push(`${file}:${lineOf(src, m.index)}`);
    }
    expect(found).toEqual([]);
  });

  it('loads the route with every shared column list a device query uses', () => {
    // `SELECT ${SOME_COLS} ... FROM devices`: the list is defined elsewhere, so
    // a forgotten jump_host_id only shows when routeOf() refuses at run time.
    const lists = new Map<string, string>();
    for (const { src } of files) {
      for (const m of src.matchAll(/\bconst ([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`/g)) lists.set(m[1], m[2]);
    }
    const missing = new Set<string>();
    for (const { file, src } of files) {
      for (const m of src.matchAll(/`\s*SELECT \$\{([A-Z][A-Z0-9_]*)\}[^`]*\bFROM devices\b/g)) {
        const cols = lists.get(m[1]);
        if (cols === undefined || !/\bjump_host_id\b/.test(cols)) missing.add(`${m[1]} (${file}:${lineOf(src, m.index!)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
