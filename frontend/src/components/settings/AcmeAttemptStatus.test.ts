import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AcmeAttemptStatus from './AcmeAttemptStatus';

const state = vi.hoisted(() => ({
  data: { lastAttempt: null as null | { time: string; action: 'issue' | 'renew'; exitCode: number; domain: string; output: string } },
  isLoading: false,
  error: null as Error | null,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => state,
}));

describe('ACME attempt status', () => {
  beforeEach(() => {
    state.data.lastAttempt = null;
    state.isLoading = false;
    state.error = null;
  });

  it('shows when there is no completed attempt', () => {
    expect(renderToStaticMarkup(createElement(AcmeAttemptStatus))).toContain('No completed Certbot attempt.');
  });

  it('shows the outcome and output of a failed request', () => {
    state.data.lastAttempt = { time: '2026-11-10T08:30:00Z', action: 'issue', exitCode: 1, domain: 'manager.example.com', output: 'Challenge failed\nCertbot detailed log:\nAuthorization error' };
    const markup = renderToStaticMarkup(createElement(AcmeAttemptStatus));
    expect(markup).toContain('Certificate request failed (exit code 1)');
    expect(markup).toContain('manager.example.com');
    expect(markup).toContain('Challenge failed');
    expect(markup).toContain('Certbot output and log');
    expect(markup).toContain('Authorization error');
  });

  it('distinguishes a successful renewal check from a renewed certificate', () => {
    state.data.lastAttempt = { time: '2026-11-10T08:30:00Z', action: 'renew', exitCode: 0, domain: 'manager.example.com', output: '' };
    expect(renderToStaticMarkup(createElement(AcmeAttemptStatus))).toContain('Renewal check succeeded');
  });

  it('surfaces status errors', () => {
    state.error = new Error('Access denied');
    expect(renderToStaticMarkup(createElement(AcmeAttemptStatus))).toContain('Access denied');
  });
});
