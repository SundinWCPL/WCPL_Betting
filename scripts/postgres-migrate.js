import { checkPostgres, createPostgresPool, runPostgresMigrations } from '../database/postgres.js';

const pool = createPostgresPool({ applicationName: 'wcpl-migrate', max: 1 });
try {
  const connection = await checkPostgres(pool);
  const applied = await runPostgresMigrations(pool);
  console.log(JSON.stringify({ ok: true, connection, applied }, null, 2));
} finally {
  await pool.end();
}
