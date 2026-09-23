import { describe, it, expect } from 'vitest';
import { docsUrl, APP_VERSION } from './version';

describe('docsUrl', () => {
  it('points at the series this build belongs to, not latest', () => {
    // mike publishes per series, so a 0.24.x install should read 0.24 docs
    // rather than whatever has shipped since.
    expect(docsUrl()).toContain('/0.24/');
  });

  it('matches the running version', () => {
    const series = /v?(\d+\.\d+)/.exec(APP_VERSION)?.[1];
    expect(docsUrl()).toContain(`/${series}/`);
  });

  it('appends a page path without doubling the slash', () => {
    expect(docsUrl('adoption/')).toMatch(/\/0\.24\/adoption\/$/);
    expect(docsUrl('/adoption/')).toMatch(/\/0\.24\/adoption\/$/);
  });
});
