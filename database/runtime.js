import { createPostgresPool, runPostgresMigrations } from './postgres.js';
import { readStateRows } from './stateStore.js';
import { decodeJsonState } from './stateCodec.js';

export const STORAGE_BACKEND = String(process.env.STORAGE_BACKEND || 'json').trim().toLowerCase();
export const postgresEnabled = STORAGE_BACKEND === 'postgres';

if (!['json', 'postgres'].includes(STORAGE_BACKEND)) {
  throw new Error(`Unsupported STORAGE_BACKEND: ${STORAGE_BACKEND}.`);
}

let pool;

async function assertPostgresRuntimeReady(activePool) {
  if (!process.env.RAILWAY_PROJECT_ID || process.env.ALLOW_EMPTY_POSTGRES === '1') return;
  const row = (await activePool.query(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM app_documents WHERE document_key='settings') AS settings,
    (SELECT count(*)::int FROM import_runs) AS imports`)).rows[0];
  if (Number(row.users) < 2 || Number(row.settings) !== 1 || Number(row.imports) < 1) {
    throw new Error(`Refusing to start PostgreSQL production runtime: database appears empty or was not imported (users=${row.users}, settings=${row.settings}, imports=${row.imports}).`);
  }
}

export async function initializePostgresRuntime() {
  if (!postgresEnabled) return null;
  pool ||= createPostgresPool({ applicationName: 'wcpl-runtime' });
  await runPostgresMigrations(pool);
  await assertPostgresRuntimeReady(pool);
  return pool;
}

export function postgresPool() {
  if (!postgresEnabled) throw new Error('PostgreSQL runtime requested while STORAGE_BACKEND is not postgres.');
  if (!pool) throw new Error('PostgreSQL runtime has not been initialized.');
  return pool;
}

export async function loadPostgresStateSnapshot() {
  const activePool = postgresPool();
  const client = await activePool.connect();
  try {
    return decodeJsonState(await readStateRows(client));
  } finally {
    client.release();
  }
}

export async function closePostgresRuntime() {
  if (!pool) return;
  const active = pool;
  pool = undefined;
  await active.end();
}
