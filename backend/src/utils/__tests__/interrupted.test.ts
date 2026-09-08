import { interruptedOutcome, INTERRUPTED_RUN_ERROR } from '../interrupted';

describe('interruptedOutcome', () => {
  // A device the run never got to needs nothing but a re-run.
  it('marks a never-reached device as skipped', () => {
    const out = interruptedOutcome('pending')!;
    expect(out.status).toBe('skipped');
    expect(out.error).toMatch(/not reached/i);
  });

  /**
   * A device that was mid-upgrade is a different situation and must read as one.
   * Its real state is unknown — it may be halfway through a reboot — so calling
   * it "skipped" alongside devices that were never touched would hide the one
   * thing the operator needs to act on.
   */
  it.each(['running', 'backing_up', 'upgrading', 'rebooting', 'verifying'])(
    'marks an in-flight device (%s) as failed, and says its state is unknown',
    (status) => {
      const out = interruptedOutcome(status)!;
      expect(out.status).toBe('failed');
      expect(out.error).toMatch(/unknown/i);
      expect(out.error).toMatch(/check the device/i);
    }
  );

  // Finished work is real work; recovery must not rewrite its history.
  it.each(['success', 'failed', 'skipped'])('leaves a finished device (%s) alone', (status) => {
    expect(interruptedOutcome(status)).toBeNull();
  });

  it('leaves an unrecognised status alone rather than guessing', () => {
    expect(interruptedOutcome('something-new')).toBeNull();
  });

  it('explains the run-level outcome without implying it resumed', () => {
    expect(INTERRUPTED_RUN_ERROR).toMatch(/restart/i);
    expect(INTERRUPTED_RUN_ERROR).toMatch(/re-run/i);
  });
});
