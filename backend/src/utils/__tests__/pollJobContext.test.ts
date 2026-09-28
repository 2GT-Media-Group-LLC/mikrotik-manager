import { runPollJob, registerPollSession, pollJobAborted } from '../pollJobContext';

describe('poll job cancellation', () => {
  it('aborts every session opened inside the job, including ones opened in callbacks', async () => {
    const aborted: string[] = [];
    const session = (name: string) => ({ abort: () => { aborted.push(name); } });
    let release!: () => void;
    const { promise, abortJob } = runPollJob(async () => {
      registerPollSession(session('first'));
      await new Promise<void>((r) => { release = r; });
      registerPollSession(session('late')); // opened after the timeout fired
      return pollJobAborted();
    });
    await new Promise((r) => setImmediate(r));
    abortJob();
    expect(aborted).toEqual(['first']);
    release();
    expect(await promise).toBe(true);
    expect(aborted).toEqual(['first', 'late']);
  });

  it('does nothing outside a poll job', () => {
    const s = { abort: jest.fn() };
    registerPollSession(s);
    expect(s.abort).not.toHaveBeenCalled();
    expect(pollJobAborted()).toBe(false);
  });

  it('keeps jobs apart', async () => {
    const a = { abort: jest.fn() };
    const b = { abort: jest.fn() };
    const jobA = runPollJob(async () => { registerPollSession(a); });
    const jobB = runPollJob(async () => { registerPollSession(b); });
    await Promise.all([jobA.promise, jobB.promise]);
    jobA.abortJob();
    expect(a.abort).toHaveBeenCalled();
    expect(b.abort).not.toHaveBeenCalled();
  });
});
