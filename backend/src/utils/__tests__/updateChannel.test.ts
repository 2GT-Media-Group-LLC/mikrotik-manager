import { resolveChannel, isUpdateChannel } from '../updateChannel';

describe('resolveChannel', () => {
  it('leaves the device alone when nothing is set, as before this existed', () => {
    expect(resolveChannel(null, null)).toBeNull();
    expect(resolveChannel(undefined, '')).toBeNull();
  });

  it('uses the fleet setting', () => {
    expect(resolveChannel(null, 'long-term')).toBe('long-term');
  });

  it('lets a device override the fleet setting', () => {
    expect(resolveChannel('testing', 'long-term')).toBe('testing');
  });

  it('ignores values RouterOS would reject', () => {
    expect(resolveChannel('bugfix', 'nonsense')).toBeNull();
    expect(resolveChannel('Stable', null)).toBeNull();
  });
});

describe('isUpdateChannel', () => {
  it('accepts the four RouterOS channels', () => {
    for (const c of ['stable', 'long-term', 'testing', 'development']) expect(isUpdateChannel(c)).toBe(true);
  });
});
