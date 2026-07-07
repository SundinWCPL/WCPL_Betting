import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

export function requireDatabaseUrl() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL commands.');
  return connectionString;
}

export function createPostgresPool(options = {}) {
  return new Pool({
    connectionString: options.connectionString || requireDatabaseUrl(),
    max: Number(options.max || process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
    application_name: options.applicationName || 'wcpl-betting'
  });
}

export async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runPostgresMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [8242026]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(row => row.version));
    const files = fs.readdirSync(migrationsDir).filter(name => /^\d+.*\.sql$/i.test(name)).sort();
    const completed = [];
    for (const filename of files) {
      if (applied.has(filename)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [filename]);
        await client.query('COMMIT');
        completed.push(filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${filename} failed: ${error.message}`);
      }
    }
    return completed;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [8242026]); } catch {}
    client.release();
  }
}

export async function checkPostgres(pool) {
  const result = await pool.query('SELECT current_database() AS database, current_user AS user, now() AS server_time');
  return result.rows[0];
}
