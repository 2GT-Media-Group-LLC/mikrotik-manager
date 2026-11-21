import { queryLimit } from '../queryLimit';

describe('queryLimit', () => {
  it('keeps a sensible value, capped at the maximum', () => {
    expect(queryLimit('20', 50, 200)).toBe(20);
    expect(queryLimit('5000', 50, 200)).toBe(200);
    expect(queryLimit(['7', '9'], 50, 200)).toBe(7);
  });

  it('falls back for anything that would have reached Postgres as a bad LIMIT', () => {
    for (const raw of ['-1', '0', 'abc', '', undefined, null]) expect(queryLimit(raw, 50, 200)).toBe(50);
  });
});
