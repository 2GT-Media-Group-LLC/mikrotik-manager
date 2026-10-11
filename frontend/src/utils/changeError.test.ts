import { describe, it, expect } from 'vitest';
import { changeErrorText } from './changeError';

describe('changeErrorText', () => {
  it('uses the server message when there is one', () => {
    expect(changeErrorText({ response: { data: { error: 'There is no bridge called x.' } } }, 'Failed')).toBe('There is no bridge called x.');
  });
  it('says the change may still be finishing when no answer came (#258)', () => {
    expect(changeErrorText({ code: 'ECONNABORTED', message: 'timeout of 120000ms exceeded' }, 'Failed'))
      .toMatch(/may still be finishing/);
  });
  it('falls back for an answer without a message', () => {
    expect(changeErrorText({ response: { status: 502, data: '<html>' } }, 'Failed to move the ports')).toBe('Failed to move the ports');
  });
});
