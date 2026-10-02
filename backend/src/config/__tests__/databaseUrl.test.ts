import { parse } from 'pg-connection-string';
import { databaseUrl } from '../database';

jest.mock('pg', () => ({ Pool: jest.fn().mockImplementation(() => ({ on: jest.fn() })) }));

describe('databaseUrl (O3)', () => {
  it('carries any password intact, encoded', () => {
    const pw = 'a/b@c:d%e+f?g#h';
    const url = databaseUrl('postgresql://mikrotik@postgres:5432/mikrotik_manager', pw)!;
    const p = parse(url);
    expect(p.password).toBe(pw);
    expect(p.user).toBe('mikrotik');
    expect(p.host).toBe('postgres');
    expect(p.database).toBe('mikrotik_manager');
  });
  it('leaves the URL alone without a separate password', () => {
    expect(databaseUrl('postgresql://u:p@h/d', undefined)).toBe('postgresql://u:p@h/d');
  });
});
