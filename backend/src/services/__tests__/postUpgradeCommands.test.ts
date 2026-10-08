// Post-upgrade commands (#163): the step a rollout runs on each upgraded device.
jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../BackupService', () => ({ BackupService: jest.fn() }));
jest.mock('../mikrotik/DeviceCollector', () => ({ DeviceCollector: jest.fn() }));
const runSsh = jest.fn();
jest.mock('../sshExec', () => ({
  runSshCommand: (...a: unknown[]) => runSsh(...a),
  looksLikeFailure: (o: string) => /failure:|syntax error|bad command/i.test(o),
}));
const safeApply = jest.fn();
jest.mock('../changeGuard/ChangeGuard', () => ({ withSafeApply: (...a: unknown[]) => safeApply(...a) }));

import { FirmwareOrchestrator } from '../FirmwareOrchestrator';

const device = { id: 8, name: 'TEST', ip_address: '192.168.0.51' };
const rollout = { post_command: '/system script run mtm-v7-setup', post_template_name: 'v7 scripts' };
const run = (o: FirmwareOrchestrator) =>
  (o as unknown as { runPostCommands: (d: unknown, r: unknown) => Promise<{ ok: boolean; output: string | null; error: string | null }> })
    .runPostCommands(device, rollout);

beforeEach(() => { runSsh.mockReset(); safeApply.mockReset(); });

it('runs the commands under Change Guard and keeps what they printed', async () => {
  runSsh.mockResolvedValue({ output: 'done' });
  safeApply.mockImplementation(async (_d: unknown, meta: { summary: string; requireProtection: boolean }, fn: () => Promise<string>) => {
    expect(meta.summary).toBe('Post-upgrade commands (v7 scripts)');
    expect(meta.requireProtection).toBe(false);
    return { result: await fn(), autoReverting: false };
  });
  expect(await run(new FirmwareOrchestrator())).toEqual({ ok: true, output: 'done', error: null });
  expect(runSsh).toHaveBeenCalledWith(device, '/system script run mtm-v7-setup');
});

it('fails on an error RouterOS reports in the text', async () => {
  runSsh.mockResolvedValue({ output: 'failure: no such item' });
  safeApply.mockImplementation(async (_d: unknown, _m: unknown, fn: () => Promise<string>) => ({ result: await fn(), autoReverting: false }));
  const r = await run(new FirmwareOrchestrator());
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/no such item/);
});

it('fails when the device stops answering and restores itself', async () => {
  safeApply.mockResolvedValue({ result: 'x', autoReverting: true });
  const r = await run(new FirmwareOrchestrator());
  expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/restoring itself/) });
});
