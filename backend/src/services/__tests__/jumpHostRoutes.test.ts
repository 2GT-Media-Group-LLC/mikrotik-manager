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
 * Connections that go to an address the manager doesn't manage yet, so there
 * is no route to give: logging in to a factory-default router on the
 * manager's own network while adopting it.
 */
const DIRECT_BY_DESIGN = new Set([
  'services/DeviceAdoptionService.ts:verifyDirect',
  'services/DeviceAdoptionService.ts:removeFactoryAddress',
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
        // The method it's in, for the allowlist.
        const before = src.slice(0, m.index);
        const fn = [...before.matchAll(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g)].pop()?.[1] ?? '?';
        if (DIRECT_BY_DESIGN.has(`${file}:${fn}`)) continue;
        missing.push(`${file}:${lineOf(src, m.index)} (${fn})`);
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
});
