import { describe, it, expect } from 'vitest';
import { activeChecks, countFindings, mutedCount } from './securityFindings';
import type { SecurityCheck } from '../services/api';

const c = (id: string, severity: SecurityCheck['severity'], suppressed = false): SecurityCheck =>
  ({ id, severity, title: id, detail: '', ...(suppressed ? { suppressed: true } : {}) });

describe('countFindings', () => {
  it('excludes muted findings — the reported bug', () => {
    // Three findings, two muted, previously reported as "3 issues found".
    const checks = [c('a', 'high'), c('b', 'medium', true), c('c', 'low', true)];
    expect(countFindings(checks)).toEqual({ high: 1, medium: 0, low: 0, total: 1 });
  });

  it('counts normally when nothing is muted', () => {
    const checks = [c('a', 'high'), c('b', 'medium'), c('c', 'low'), c('d', 'low')];
    expect(countFindings(checks)).toEqual({ high: 1, medium: 1, low: 2, total: 4 });
  });

  it('reports zero when everything is muted', () => {
    const checks = [c('a', 'high', true), c('b', 'low', true)];
    expect(countFindings(checks).total).toBe(0);
  });

  it('handles an empty list', () => {
    expect(countFindings([])).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
  });
});

describe('activeChecks', () => {
  it('keeps the unmuted ones in order', () => {
    const checks = [c('a', 'high'), c('b', 'medium', true), c('c', 'low')];
    expect(activeChecks(checks).map((x) => x.id)).toEqual(['a', 'c']);
  });
});

describe('mutedCount', () => {
  it('counts what was filtered out, so the UI can say so', () => {
    expect(mutedCount([c('a', 'high'), c('b', 'medium', true), c('c', 'low', true)])).toBe(2);
  });

  it('is zero when nothing is muted', () => {
    expect(mutedCount([c('a', 'high')])).toBe(0);
  });
});
