import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function stripSslModeParam(url: string): string {
  return url
    .replace(/([?&])sslmode=[^&]*(?=&|$)/, '$1')
    .replace(/[?&]$/, '');
}

export { stripSslModeParam };

export function getPool(): pg.Pool {
  if (!pool) {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error('DATABASE_URL is required');
    const connectionString = stripSslModeParam(raw);
    const useSsl = process.env.PG_SSL !== 'false';
    pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 20),
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export async function pingDb(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
