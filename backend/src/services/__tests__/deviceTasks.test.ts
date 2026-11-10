import type { Response } from 'express';
import { answerWithTask, answerTaskStatus, taskView, clearTasksForTest } from '../deviceTasks';

function fakeRes() {
  const r = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { r.statusCode = code; return res; },
    json(body: unknown) { r.body = body; return res; },
  } as unknown as Response;
  return { res, r };
}

const later = <T>(ms: number, v: T, fail = false) =>
  new Promise<T>((resolve, reject) => setTimeout(() => (fail ? reject(new Error(String(v))) : resolve(v)), ms));

const failure = (err: unknown) => ({ httpStatus: 502, error: `Could not: ${(err as Error).message}` });

beforeEach(() => clearTasksForTest());

describe('answerWithTask (#417)', () => {
  it('answers with the result when the task finishes in time', async () => {
    const { res, r } = fakeRes();
    const detach = jest.fn();
    await answerWithTask(res, 'k1', () => later(5, { switched: true }), { failure, stillRunning: {}, detach, waitMs: 200 });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ switched: true });
    expect(detach).not.toHaveBeenCalled();
  });

  it('answers a quick failure with its status and reason', async () => {
    const { res, r } = fakeRes();
    await answerWithTask(res, 'k2', () => later(5, 'no api-ssl service', true), { failure, stillRunning: {}, waitMs: 200 });
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'Could not: no api-ssl service' });
  });

  it('answers 202 for a slow task, keeps the lock, and records the outcome', async () => {
    const { res, r } = fakeRes();
    const release = jest.fn();
    const onSettled = jest.fn();
    await answerWithTask(res, 'k3', () => later(60, { switched: true }), {
      failure, stillRunning: { message: 'Still working' }, detach: () => release, onSettled, waitMs: 10,
    });
    expect(r.statusCode).toBe(202);
    expect(r.body).toEqual({ status: 'running', message: 'Still working' });
    expect(taskView('k3')?.status).toBe('running');
    expect(release).not.toHaveBeenCalled();

    await later(100, null);
    expect(taskView('k3')).toEqual({ status: 'done', result: { switched: true } });
    expect(release).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('records a slow failure for the status request', async () => {
    const { res } = fakeRes();
    await answerWithTask(res, 'k4', () => later(30, 'signing timed out', true), { failure, stillRunning: {}, waitMs: 5 });
    await later(60, null);
    const s = fakeRes();
    answerTaskStatus(s.res, 'k4', 'a switch');
    expect(s.r.body).toEqual({ status: 'failed', http_status: 502, error: 'Could not: signing timed out' });
  });

  it('says plainly when there is no record of the task', () => {
    const { res, r } = fakeRes();
    answerTaskStatus(res, 'missing', 'a switch to API-SSL');
    expect(r.statusCode).toBe(404);
    expect((r.body as { error: string }).error).toMatch(/no record of a switch to API-SSL/);
  });
});
