import { describe, it, expect } from 'vitest';
import { parseColumnPrefs, visibleColumns, clampWidth, DEVICE_COLUMNS, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH } from './deviceColumns';

describe('device column preferences', () => {
  it('starts with every column shown and no widths', () => {
    const p = parseColumnPrefs(null);
    expect(p).toEqual({ hidden: [], widths: {} });
    expect(visibleColumns(p)).toHaveLength(DEVICE_COLUMNS.length);
  });

  it('hides chosen columns but never the fixed ones', () => {
    const p = parseColumnPrefs(JSON.stringify({ hidden: ['serial', 'rack', 'device', 'actions', 'status'] }));
    expect(p.hidden).toEqual(['serial', 'rack']);
    const ids = visibleColumns(p).map((c) => c.id);
    expect(ids).not.toContain('serial');
    expect(ids).toContain('device');
    expect(ids).toContain('actions');
  });

  it('drops unknown columns and bad widths, and clamps the rest', () => {
    const p = parseColumnPrefs(JSON.stringify({
      hidden: ['nope', 7, 'ip', 'ip'],
      widths: { model: 5, ip: 5000, cpu: 'wide', bogus: 100, rack: 140.6 },
    }));
    expect(p.hidden).toEqual(['ip']);
    expect(p.widths).toEqual({ model: MIN_COLUMN_WIDTH, ip: MAX_COLUMN_WIDTH, rack: 141 });
  });

  it('copes with junk in storage', () => {
    expect(parseColumnPrefs('not json')).toEqual({ hidden: [], widths: {} });
    expect(parseColumnPrefs('"a string"')).toEqual({ hidden: [], widths: {} });
    expect(clampWidth(200)).toBe(200);
  });
});
