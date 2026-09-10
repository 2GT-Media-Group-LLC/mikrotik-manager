import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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

/**
 * A console call whose format string is a template literal *and* which passes
 * further arguments lets an interpolated value act as a format specifier: a MAC
 * containing "%s" turns the message into a format string and swallows the next
 * argument. That is CodeQL's js/tainted-format-string, and it reached
 * production twice in clients.ts.
 *
 * logSafe() deliberately does not neutralise "%" — doing so would corrupt every
 * legitimate percentage in the logs. The rule is structural instead: if you pass
 * extra arguments, the format string must be a literal.
 *
 * Scoped to values wrapped in logSafe(), on purpose. That wrapper is the author
 * saying "this is untrusted", which is exactly when the format position matters.
 * A wider sweep flags ~40 call sites that interpolate a device name unsanitised
 * — a real but separate concern (they need logSafe first, not a different format
 * string), and one worth handling deliberately rather than smuggling in here.
 */
function offendingCalls(src: string): string[] {
  const hits: string[] = [];
  const re = /console\.(log|warn|error|info|debug)\(\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Walk to the end of the template literal, honouring escapes and ${...}.
    let i = re.lastIndex;
    let interpolated = false;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (depth === 0 && c === '`') break;
      if (c === '$' && src[i + 1] === '{') { interpolated = true; depth++; i++; continue; }
      if (depth > 0 && c === '}') depth--;
    }
    // A comma straight after the closing backtick means further arguments.
    const rest = src.slice(i + 1).trimStart();
    const template = src.slice(m.index, i + 1);
    const sanitisedValue = /\$\{[^}]*logSafe\(/.test(template);
    if (interpolated && sanitisedValue && rest.startsWith(',')) {
      hits.push(src.slice(m.index, Math.min(i + 1, m.index + 120)));
    }
  }
  return hits;
}

describe('console format strings', () => {
  it('never puts a logSafe() value in the format position with extra arguments', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const hit of offendingCalls(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(SRC, '')}: ${hit.replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The detector has to actually detect; a guard that cannot fail guards nothing.
  it('recognises the shape it exists to prevent', () => {
    expect(offendingCalls('console.error(`oops ${logSafe(mac)}:`, err);')).toHaveLength(1);
  });

  it('accepts the safe forms', () => {
    expect(offendingCalls('console.error(`oops ${logSafe(mac)}`);')).toHaveLength(0);
    expect(offendingCalls("console.error('oops %s:', logSafe(mac), err);")).toHaveLength(0);
    expect(offendingCalls('console.error(`plain`, err);')).toHaveLength(0);
  });
});
