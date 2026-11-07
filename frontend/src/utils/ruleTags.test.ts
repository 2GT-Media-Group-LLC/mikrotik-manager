import { describe, it, expect } from 'vitest';
import { tagOf, logsUntagged, ruleLinesUrl, ruleUrl } from './ruleTags';

describe('rule tags (#369)', () => {
  it('reads the tag the backend writes', () => {
    expect(tagOf('MTM-FW-DROP mtm#7F3a')).toBe('7f3a');
    expect(tagOf('WAN-in')).toBeNull();
    expect(logsUntagged({ log: 'yes', 'log-prefix': 'WAN' })).toBe(true);
    expect(logsUntagged({ log: 'yes', 'log-prefix': 'WAN mtm#ab12' })).toBe(false);
    expect(logsUntagged({ log: 'true', dynamic: 'true' })).toBe(false);
  });
  it('links both ways', () => {
    expect(ruleLinesUrl(8, 'ab12')).toBe('/firewall-events?device=8&search=mtm%23ab12');
    expect(ruleUrl(8, 'ab12')).toBe('/devices/8?tab=firewall&rule=ab12');
  });
});
