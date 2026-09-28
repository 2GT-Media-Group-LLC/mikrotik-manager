import { exportPlan, isRouterOs6 } from '../backupExport';

describe('exportPlan (#172)', () => {
  it('leaves secrets out on v7 unless asked', () => {
    expect(exportPlan('7.24.4', false)).toEqual({ command: '/export compact', containsSecrets: false });
    expect(exportPlan('7.24.4', true)).toEqual({ command: '/export compact show-sensitive', containsSecrets: true });
  });

  it('treats an unknown version as holding secrets, since it may be v6', () => {
    expect(exportPlan(null, false)).toEqual({ command: '/export compact', containsSecrets: true });
    expect(exportPlan('', true)).toEqual({ command: '/export compact', containsSecrets: true });
  });

  it('hides v6 secrets unless asked, since v6 includes them by default', () => {
    expect(exportPlan('6.49.10', false)).toEqual({ command: '/export compact hide-sensitive', containsSecrets: false });
    expect(exportPlan('6.49.10', true)).toEqual({ command: '/export compact', containsSecrets: true });
  });

  it('recognises v6 versions only', () => {
    expect(isRouterOs6('6.48.6')).toBe(true);
    expect(isRouterOs6(' 6.49 ')).toBe(true);
    expect(isRouterOs6('7.6')).toBe(false);
    expect(isRouterOs6('16.1')).toBe(false);
  });
});
