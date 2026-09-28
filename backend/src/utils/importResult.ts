/**
 * What a RouterOS `/import` actually did (P1-10).
 *
 * `/import` always exits 0 over SSH, success or failure, so its printed output
 * is the only signal. Measured on RouterOS 7.24.4:
 *
 *   success  "Script file loaded and executed successfully"
 *   failure  "Script Error: failure: already have interface with name bridge
 *             (/interface/bridge/add; line 2) (:import; line 1)"
 *   missing  "Cannot open import file, file does not exist (:import; line 1)"
 *
 * An import stops at the first failing line and keeps everything before it.
 * Restore and rollback used to ignore the output and report success, although
 * replaying a backup over a running configuration usually fails at its first
 * `add` of something that already exists.
 */

export type ImportStatus = 'applied' | 'nothing_applied' | 'partial';

export interface ImportResult {
  status: ImportStatus;
  /** Line of the backup RouterOS stopped at, when it said. */
  failedLine?: number;
  /** Commands before that line that ran (comments and section headers don't count). */
  appliedCommands?: number;
  error?: string;
}

const SUCCESS = 'Script file loaded and executed successfully';

export function parseImportOutput(output: string, script: string): ImportResult {
  const text = output.trim();
  if (text.includes(SUCCESS) && !/Script Error|failure:|error/i.test(text.replace(SUCCESS, ''))) {
    return { status: 'applied' };
  }

  // The first "(<command>; line N)" is the failing line of the backup; a later
  // "(:import; line 1)" is the position of the /import command itself.
  const m = text.match(/\((?!:import;)[^;()]*;\s*line (\d+)\)/) ?? text.match(/line (\d+)(?: column \d+)?/);
  const failedLine = m ? parseInt(m[1], 10) : undefined;
  const error = cleanError(text);

  if (!failedLine) return { status: 'nothing_applied', error };
  const appliedCommands = countCommandsBefore(script, failedLine);
  return {
    status: appliedCommands > 0 ? 'partial' : 'nothing_applied',
    failedLine,
    appliedCommands,
    error,
  };
}

/** The error message without the position suffixes RouterOS appends. */
function cleanError(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l) ?? text;
  return line
    .replace(/^Script Error:\s*/i, '')
    .replace(/\s*\([^()]*;\s*line \d+\)/g, '')
    .trim()
    .slice(0, 300);
}

/**
 * Configuration commands on lines before `line` (1-based). Blank lines,
 * comments, continuation lines and bare section paths (`/interface bridge`)
 * change nothing on their own, so they are not counted.
 */
export function countCommandsBefore(script: string, line: number): number {
  const lines = script.split(/\r?\n/).slice(0, Math.max(0, line - 1));
  let count = 0;
  let continuing = false;
  for (const raw of lines) {
    const l = raw.trim();
    const isContinuation = continuing;
    continuing = raw.trimEnd().endsWith('\\');
    if (isContinuation || !l || l.startsWith('#')) continue;
    // A bare path like `/ip address` only selects a menu. A whole-word verb or
    // an `=` makes it a command (`/system identity set name=x`).
    if (l.startsWith('/') && !l.includes('=') && !/\s(add|set|remove|unset|enable|disable|move)(\s|$)/.test(l)) continue;
    count++;
  }
  return count;
}
