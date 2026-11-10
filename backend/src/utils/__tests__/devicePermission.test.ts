import { during, permissionProblem, isPermissionError } from '../devicePermission';

describe('permission refusals (#417)', () => {
  const refused = () => Promise.reject(new Error('not enough permissions (9)'));

  it('names the step RouterOS refused, and the innermost one wins', async () => {
    const err = await during('switching to API-SSL', () => during('signing the certificate', refused)).catch((e) => e);
    expect(err.during).toBe('signing the certificate');
    expect(permissionProblem(err, 'mtm')).toBe(
      'RouterOS refused signing the certificate with "not enough permissions": mtm, the user the manager logs in as, '
      + 'lacks a right this needs. Put it in the full group (/user set [find name="mtm"] group=full), or give its group the missing policies.');
  });

  it('leaves other errors alone', async () => {
    const err = await during('reading the services', () => Promise.reject(new Error('timeout'))).catch((e) => e);
    expect(isPermissionError(err)).toBe(false);
    expect(permissionProblem(err, 'mtm')).toBeNull();
    expect(await during('x', () => Promise.resolve(5))).toBe(5);
  });
});
