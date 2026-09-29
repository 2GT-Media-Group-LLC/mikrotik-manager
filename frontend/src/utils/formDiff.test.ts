import { describe, it, expect } from 'vitest';
import { changedFields } from './formDiff';

describe('changedFields', () => {
  it('returns only what the operator changed', () => {
    const loaded = { identity: 'sw1', ntp_primary: 'pool.ntp.org', time: '10:01' };
    expect(changedFields(loaded, { ...loaded, identity: 'sw1-core' })).toEqual({ identity: 'sw1-core' });
  });

  it('keeps a cleared field, so clearing is sent', () => {
    expect(changedFields({ comment: 'old' }, { comment: '' })).toEqual({ comment: '' });
  });

  it('treats a number and its string form as the same', () => {
    expect(changedFields({ frequency: 2437 }, { frequency: '2437' } as unknown as { frequency: number })).toEqual({});
  });

  it('compares arrays by content', () => {
    expect(changedFields({ auth: ['wpa2-psk'] }, { auth: ['wpa2-psk'] })).toEqual({});
    expect(changedFields({ auth: ['wpa2-psk'] }, { auth: ['wpa2-psk', 'wpa3-psk'] })).toEqual({ auth: ['wpa2-psk', 'wpa3-psk'] });
  });
});
