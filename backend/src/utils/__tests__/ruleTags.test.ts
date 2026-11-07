import { tagOf, withTag, newTag, tagsIn, planTags, tagParams, tagOfLogLine, logsUntagged } from '../ruleTags';

describe('rule tags (#369)', () => {
  it('reads and writes the tag at the end of a prefix, keeping the rest', () => {
    expect(tagOf('MTM-FW-DROP mtm#7f3a')).toBe('7f3a');
    expect(tagOf('mtm#AB12')).toBe('ab12');
    expect(tagOf('WAN-in')).toBeNull();
    expect(tagOf('xmtm#7f3a')).toBeNull();
    expect(withTag('MTM-FW-DROP ', '7f3a')).toBe('MTM-FW-DROP mtm#7f3a');
    expect(withTag('', 'q1w2')).toBe('mtm#q1w2');
    // Re-tagging replaces the old tag rather than adding a second.
    expect(withTag('WAN-in mtm#aaaa', 'bbbb')).toBe('WAN-in mtm#bbbb');
  });

  it('never reuses a tag on the device', () => {
    const taken = new Set(['aaaa']);
    for (let i = 0; i < 200; i++) { const t = newTag(taken); expect(t).toMatch(/^[0-9a-z]{4}$/); expect(taken.has(t)).toBe(false); taken.add(t); }
  });

  it('plans a tag for each configured rule that logs without one', () => {
    const rules: Record<string, string>[] = [
      { '.id': '*1', log: 'yes', 'log-prefix': 'MTM-FW-DROP ' },
      { '.id': '*2', log: 'yes', 'log-prefix': 'WAN mtm#zz99' },
      { '.id': '*3', log: 'no', 'log-prefix': 'quiet' },
      { '.id': '*4', log: 'true', dynamic: 'true' },
      { '.id': '*5', log: 'true' },
    ];
    expect(rules.filter(logsUntagged).map((r) => r['.id'])).toEqual(['*1', '*5']);
    const plan = planTags(rules, tagsIn(rules));
    expect(plan.map((p) => p.id)).toEqual(['*1', '*5']);
    expect(plan[0].to).toMatch(/^MTM-FW-DROP mtm#[0-9a-z]{4}$/);
    expect(plan[1].to).toMatch(/^mtm#[0-9a-z]{4}$/);
    expect(new Set([...plan.map((p) => tagOf(p.to)), 'zz99']).size).toBe(3);
  });

  it('tags a new or edited rule only when it logs', () => {
    expect(tagParams({ chain: 'input', log: 'yes', 'log-prefix': 'IN' }, new Set())['log-prefix']).toMatch(/^IN mtm#/);
    expect(tagParams({ chain: 'input', log: 'no' }, new Set())).toEqual({ chain: 'input', log: 'no' });
    expect(tagParams({ disabled: 'yes' }, new Set())).toEqual({ disabled: 'yes' });
    expect(tagParams({ log: 'yes', 'log-prefix': 'IN mtm#abcd' }, new Set())['log-prefix']).toBe('IN mtm#abcd');
  });

  it('reads the tag off a RouterOS log line, from the prefix only', () => {
    expect(tagOfLogLine('MTM-FW-ACCEPT mtm#ab12 input: in:bridge out:(unknown 0), proto TCP, 192.168.0.76:58199->192.168.0.51:8729, len 64')).toBe('ab12');
    expect(tagOfLogLine('mtm#q1w2 forward: in:ether1 out:ether2, proto UDP')).toBe('q1w2');
    // A tag-like word later in the line isn't the rule's.
    expect(tagOfLogLine('input: in:ether1 out:(unknown 0), comment mtm#ab12')).toBeNull();
  });
});
