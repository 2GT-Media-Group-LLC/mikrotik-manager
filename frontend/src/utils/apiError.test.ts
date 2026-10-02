import { describe, it, expect } from 'vitest';
import { apiErrorMessage } from './apiError';

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
