import { stepFailure, isPartialApply } from '../partialApply';
import { RouterOSError, RouterOSTrapError } from '../../mikrotik/RouterOSClient';

describe('stepFailure', () => {
  it('treats a !trap before any write as a plain rejection', () => {
    expect(isPartialApply(stepFailure(new RouterOSTrapError('no such item'), false))).toBe(false);
  });
  it('treats a failure before anything was sent as a plain rejection', () => {
    expect(isPartialApply(stepFailure(new RouterOSError('Not connected'), false))).toBe(false);
  });
  it.each([
    ['protocol error', new RouterOSError('Protocol error from device: reserved control byte 0xf8')],
    ['!fatal', new RouterOSError('Fatal error received')],
    ['timeout', new Error('Command timeout')],
    ['unknown error', new Error('boom')],
  ])('keeps the revert armed for an ambiguous first write (%s)', (_n, err) => {
    expect(isPartialApply(stepFailure(err, false))).toBe(true);
  });
  it('is partial once anything was written, even for a !trap', () => {
    expect(isPartialApply(stepFailure(new RouterOSTrapError('bad'), true))).toBe(true);
  });
});
