import { describe, it, expect } from 'vitest';
import { lineDiff } from './lineDiff';

const rebuild = (rows: ReturnType<typeof lineDiff>, side: 'old' | 'new') =>
  rows.filter((r) => r.type === 'ctx' || r.type === (side === 'old' ? 'del' : 'add')).map((r) => r.text).join('\n');

describe('lineDiff', () => {
  it('finds a changed line', () => {
    const rows = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(rows).toEqual([{ type: 'ctx', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'B' }, { type: 'ctx', text: 'c' }]);
  });

  // Outside review U11: two large configurations used to freeze the tab.
  it('diffs two 20,000-line configurations quickly', () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `/ip firewall address-list add list=x address=10.0.${i >> 8}.${i & 255}`);
    const changed = [...base];
    changed[5_000] = '/ip firewall address-list add list=x address=192.0.2.1';
    changed.splice(15_000, 0, '/system identity set name=new');
    const t = performance.now();
    const rows = lineDiff(base.join('\n'), changed.join('\n'));
    expect(performance.now() - t).toBeLessThan(500);
    expect(rows.filter((r) => r.type !== 'ctx')).toHaveLength(3);
  });

  it('stays bounded and correct when two large configurations differ throughout', () => {
    const a = Array.from({ length: 6_000 }, (_, i) => `line ${i}`);
    const b = Array.from({ length: 6_000 }, (_, i) => (i % 3 === 0 ? `changed ${i}` : `line ${i}`));
    const t = performance.now();
    const rows = lineDiff(a.join('\n'), b.join('\n'));
    expect(performance.now() - t).toBeLessThan(1_000);
    // Whatever the path, the rows rebuild both sides exactly.
    expect(rebuild(rows, 'old')).toBe(a.join('\n'));
    expect(rebuild(rows, 'new')).toBe(b.join('\n'));
  });
});
