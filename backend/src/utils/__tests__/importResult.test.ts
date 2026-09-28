import { parseImportOutput, countCommandsBefore } from '../importResult';

// Output captured from RouterOS 7.24.4 (the TEST switch).
const OK = 'Script file loaded and executed successfully\n';
const FAIL_LINE_2 =
  'Script Error: failure: already have interface with name bridge (/interface/bridge/add; line 2) (:import; line 1)\n';
const MISSING = 'Cannot open import file, file does not exist (:import; line 1)\n';

describe('parseImportOutput', () => {
  it('recognises a complete import', () => {
    expect(parseImportOutput(OK, '/system identity set name=x\n')).toEqual({ status: 'applied' });
  });

  it('reports a partial import, with the line it stopped at', () => {
    const script = '/system identity set name=x\n/interface bridge add name=bridge\n/system identity set name=x\n';
    const r = parseImportOutput(FAIL_LINE_2, script);
    expect(r.status).toBe('partial');
    expect(r.failedLine).toBe(2);
    expect(r.appliedCommands).toBe(1);
    expect(r.error).toBe('failure: already have interface with name bridge');
  });

  it('reports nothing applied when only comments and headers came first', () => {
    // What replaying a real export usually looks like: header comment, a section
    // path, then an add of something that already exists.
    const script = '# 2026-09-27 by RouterOS 7.24.4\n/interface bridge\nadd name=bridge\n';
    const out = 'Script Error: failure: already have interface with name bridge (/interface/bridge/add; line 3) (:import; line 1)';
    const r = parseImportOutput(out, script);
    expect(r.status).toBe('nothing_applied');
    expect(r.failedLine).toBe(3);
  });

  it('treats a missing file or an unrecognised reply as a failure, never success', () => {
    expect(parseImportOutput(MISSING, '').status).toBe('nothing_applied');
    expect(parseImportOutput('', 'add name=x').status).toBe('nothing_applied');
    expect(parseImportOutput('something unexpected', 'add name=x').status).toBe('nothing_applied');
  });
});

describe('countCommandsBefore', () => {
  it('skips comments, bare section paths and continuation lines', () => {
    const script = [
      '# header',
      '/interface bridge',
      'add name=bridge \\',
      '    protocol-mode=rstp',
      '/ip address',
      'add address=10.0.0.1/24 interface=bridge',
      'add address=10.0.1.1/24 interface=bridge',
    ].join('\n');
    expect(countCommandsBefore(script, 1)).toBe(0);
    expect(countCommandsBefore(script, 3)).toBe(0);
    expect(countCommandsBefore(script, 5)).toBe(1);
    expect(countCommandsBefore(script, 7)).toBe(2);
  });
});
