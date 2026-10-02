import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

/**
 * DB_PASSWORD, when set, is put into the URL percent-encoded (outside review
 * O3): written into the URL by hand, a generated password containing '/', '@'
 * or ':' broke it and with it the whole stack. (pg's own `password` option
 * can't be used: a password-less URL overrides it with undefined.)
 */
export function databaseUrl(url: string | undefined, password: string | undefined): string | undefined {
  if (!url || !password) return url;
  const u = new URL(url);
  // Encoded in full: the URL setter leaves '@', '%' and '#' as they are.
  u.password = encodeURIComponent(password);
  return u.toString();
}

export const pool = new Pool({
  connectionString: databaseUrl(process.env.DATABASE_URL, process.env.DB_PASSWORD),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function transaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
