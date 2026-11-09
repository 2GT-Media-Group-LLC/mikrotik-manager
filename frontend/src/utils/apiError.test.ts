import { describe, it, expect } from 'vitest';
import { apiErrorMessage, longRequestError } from './apiError';

describe('apiErrorMessage (#180)', () => {
  it("prefers the server's message", () => {
    const err = Object.assign(new Error('Request failed with status code 500'), { response: { data: { error: 'no such command prefix' } } });
    expect(apiErrorMessage(err)).toBe('no such command prefix');
  });
  it('falls back to the error, then the fallback', () => {
    expect(apiErrorMessage(new Error('Network Error'))).toBe('Network Error');
    expect(apiErrorMessage(undefined, 'Save failed')).toBe('Save failed');
  });
});

describe('longRequestError (#417)', () => {
  it("prefers the manager's own reason", () => {
    expect(longRequestError({ response: { status: 502, data: { error: 'Could not enable API-SSL: no api-ssl service' } } }, 'Could not enable API-SSL'))
      .toBe('Could not enable API-SSL: no api-ssl service');
  });
  it('says a reply was lost to a proxy or restart, and that it may still finish', () => {
    const m = longRequestError({ response: { status: 504, statusText: 'Gateway Time-out', data: '<html>504</html>' } }, 'Could not enable API-SSL');
    expect(m).toMatch(/HTTP 504 Gateway Time-out/);
    expect(m).toMatch(/reverse proxy/);
    expect(m).toMatch(/may still finish/);
  });
  it('says when nothing came back in time', () => {
    expect(longRequestError({ code: 'ECONNABORTED', message: 'timeout of 240000ms exceeded' }, 'Could not enable API-SSL'))
      .toMatch(/no answer from the manager in time/);
  });
  it('names other statuses and plain network errors', () => {
    expect(longRequestError({ response: { status: 413, data: '' } }, 'X')).toBe('X (HTTP 413)');
    expect(longRequestError({ message: 'Network Error' }, 'X')).toBe('X: Network Error');
  });
});
