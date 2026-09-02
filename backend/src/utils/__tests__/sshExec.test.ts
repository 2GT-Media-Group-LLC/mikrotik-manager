import { looksLikeFailure } from '../../services/sshExec';

describe('looksLikeFailure', () => {
  it('catches the ways RouterOS reports a bad command', () => {
    // RouterOS signals most errors in the text, not an exit code — a command
    // that worked and one that was rejected are otherwise indistinguishable.
    expect(looksLikeFailure('syntax error (line 1 column 5)')).toBe(true);
    expect(looksLikeFailure('bad command name foo (line 1 column 1)')).toBe(true);
    expect(looksLikeFailure('expected end of command (line 1 column 20)')).toBe(true);
    expect(looksLikeFailure('no such item (4)')).toBe(true);
    expect(looksLikeFailure('failure: already have such address')).toBe(true);
    expect(looksLikeFailure('input does not match any value of interface')).toBe(true);
  });

  it('treats ordinary output as success', () => {
    // Misreading normal output as failure would halt a rollout that was working,
    // which is worse than the error it was trying to catch.
    expect(looksLikeFailure('')).toBe(false);
    expect(looksLikeFailure('  name: MikroTik-Test')).toBe(false);
    expect(looksLikeFailure('0   ether1  ether  1500  enabled')).toBe(false);
    expect(looksLikeFailure('142.250.187.206')).toBe(false);
  });

  it('does not fire on words merely containing an error term', () => {
    expect(looksLikeFailure('comment="no such item handling"')).toBe(false);
    expect(looksLikeFailure('name=syntax-error-test')).toBe(false);
  });

  it('finds a failure on any line, not only the first', () => {
    expect(looksLikeFailure('0 ether1\n1 ether2\nno such item (4)')).toBe(true);
  });
});
