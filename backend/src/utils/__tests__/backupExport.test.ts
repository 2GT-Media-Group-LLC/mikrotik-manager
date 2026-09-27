import { exportPlan, isRouterOs6 } from '../backupExport';

describe('exportPlan (#172)', () => {
  it('leaves secrets out on v7 unless asked', () => {
    expect(exportPlan('7.24.4', false)).toEqual({ command: '/export compact', containsSecrets: false });
    expect(exportPlan('7.24.4', true)).toEqual({ command: '/export compact show-sensitive', containsSecrets: true });
  });

  it('treats an unknown version like v7', () => {
    expect(exportPlan(null, false).containsSecrets).toBe(false);
    expect(exportPlan('', true).command).toBe('/export compact show-sensitive');
  });

  it('marks v6 exports as holding secrets either way, since v6 includes them by default', () => {
    expect(exportPlan('6.49.10', false)).toEqual({ command: '/export compact', containsSecrets: true });
    expect(exportPlan('6.49.10', true).containsSecrets).toBe(true);
  });

  it('recognises v6 versions only', () => {
    expect(isRouterOs6('6.48.6')).toBe(true);
    expect(isRouterOs6(' 6.49 ')).toBe(true);
    expect(isRouterOs6('7.6')).toBe(false);
    expect(isRouterOs6('16.1')).toBe(false);
  });
});
