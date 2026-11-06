import { unifiedDiff, capText } from '../configDiff';

const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

describe('unifiedDiff (#406)', () => {
  it('shows one changed line with three lines around it', () => {
    const next = [...base];
    next[9] = 'line 10 changed';
    expect(unifiedDiff(base.join('\n'), next.join('\n'))).toBe([
      '--- previous', '+++ current', '@@ -7,7 +7,7 @@',
      ' line 7', ' line 8', ' line 9', '-line 10', '+line 10 changed', ' line 11', ' line 12', ' line 13',
    ].join('\n'));
  });

  it('keeps separate changes in separate hunks, and merges close ones', () => {
    const next = [...base];
    next[1] = 'two';
    next[17] = 'eighteen';
    const d = unifiedDiff(base.join('\n'), next.join('\n'))!;
    expect(d.match(/^@@/gm)).toHaveLength(2);
    const close = [...base];
    close[5] = 'six';
    close[8] = 'nine';
    expect(unifiedDiff(base.join('\n'), close.join('\n'))!.match(/^@@/gm)).toHaveLength(1);
  });

  it('shows added and removed lines with the right counts', () => {
    const next = [...base.slice(0, 5), 'added a', 'added b', ...base.slice(5, 15), ...base.slice(16)];
    const d = unifiedDiff(base.join('\n'), next.join('\n'))!;
    expect(d).toContain('+added a\n+added b');
    expect(d).toContain('-line 16');
    expect(d).toContain('@@ -3,6 +3,8 @@');
  });

  it('cuts a long diff and says how much more there is', () => {
    const next = base.map((l) => `${l}!`);
    const d = unifiedDiff(base.join('\n'), next.join('\n'), { maxLines: 10 })!;
    expect(d.split('\n')).toHaveLength(13);
    expect(d).toMatch(/… \d+ more lines: see Config History$/);
  });

  it('returns null with nothing to show', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBeNull();
  });
});

describe('capText', () => {
  it('cuts at a line break and says so', () => {
    expect(capText('aaa\nbbb\nccc', 100)).toBe('aaa\nbbb\nccc');
    expect(capText('aaa\nbbb\nccc', 8)).toBe('aaa\nbbb\n… more: see Config History');
  });
});
