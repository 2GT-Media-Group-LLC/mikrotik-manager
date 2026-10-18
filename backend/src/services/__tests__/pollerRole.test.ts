import { parsePollerRole } from '../pollerRole';

describe('POLLER_ROLE (#301)', () => {
  it('reads api and worker, any case', () => {
    expect(parsePollerRole('api')).toBe('api');
    expect(parsePollerRole(' Worker ')).toBe('worker');
  });

  it('anything else is everything, so a typo cannot stop polling', () => {
    for (const v of [undefined, '', 'all', 'workers', 'none']) expect(parsePollerRole(v)).toBe('all');
  });
});
