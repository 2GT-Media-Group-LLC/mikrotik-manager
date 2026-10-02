import { describe, it, expect } from 'vitest';
import { docsUrl, APP_VERSION } from './version';

describe('docsUrl', () => {
  it('points at the series this build belongs to, not latest', () => {
    // mike publishes per series, so a 0.25.x install reads 0.25 docs rather
    // than whatever has shipped since.
    expect(docsUrl()).toMatch(/\/\d+\.\d+\/$/);
    expect(docsUrl()).not.toContain('/latest/');
  });

  it('matches the running version', () => {
    const series = /v?(\d+\.\d+)/.exec(APP_VERSION)?.[1];
    expect(docsUrl()).toContain(`/${series}/`);
  });

  it('appends a page path without doubling the slash', () => {
    const series = /v?(\d+\.\d+)/.exec(APP_VERSION)?.[1];
    expect(docsUrl('adoption/')).toMatch(new RegExp(`/${series}/adoption/$`));
    expect(docsUrl('/adoption/')).toMatch(new RegExp(`/${series}/adoption/$`));
  });
});
