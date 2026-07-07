import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPostgresPool, runPostgresMigrations, withTransaction } from '../database/postgres.js';
import { decodeJsonState, encodeJsonState, IMPORT_TABLES, stateManifest } from '../database/stateCodec.js';
import { clearImportedState, databaseCountManifest, insertStateRows, readStateRows, synchronizeRuntimeSequences } from '../database/stateStore.js';

const args = process.argv.slice(2);
const sourcePath = args.find(value => !value.startsWith('--'));
const replace = args.includes('--replace');
const fullVerify = args.includes('--full-verify');
if (!sourcePath) throw new Error('Usage: npm run db:import -- <betting.json> [--replace] [--full-verify]');

const absolutePath = path.resolve(sourcePath);
const raw = fs.readFileSync(absolutePath);
const source = JSON.parse(raw.toString('utf8'));
const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
const encoded = encodeJsonState(source);
const manifest = stateManifest(source, encoded);
const pool = createPostgresPool({ applicationName: 'wcpl-json-import', max: 2 });

try {
  await runPostgresMigrations(pool);
  await withTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [8242027]);
    const existing = Number((await client.query('SELECT count(*)::bigint AS count FROM users')).rows[0].count);
    if (existing && !replace) throw new Error(`PostgreSQL already contains ${existing} users. Re-run with --replace only for an intentional full replacement.`);
    if (replace) await clearImportedState(client);
    for (const table of IMPORT_TABLES) {
      const count = await insertStateRows(client, table, encoded[table]);
      process.stdout.write(`${table}: ${count}\n`);
    }
    await synchronizeRuntimeSequences(client);
    await client.query(
      'INSERT INTO import_runs(source_sha256, source_bytes, source_path, manifest) VALUES($1,$2,$3,$4::jsonb)',
      [sha256, raw.length, absolutePath, JSON.stringify(manifest)]
    );
  });
  const databaseManifest = await databaseCountManifest(pool);
  assert.deepStrictEqual(databaseManifest.counts, manifest.counts, 'Imported PostgreSQL row counts do not match the source manifest.');
  if (fullVerify) {
    const restored = decodeJsonState(await readStateRows(pool));
    assert.deepStrictEqual(restored, source, 'Full PostgreSQL round-trip differs from the source JSON.');
  }
  console.log(JSON.stringify({ ok: true, source: absolutePath, bytes: raw.length, sha256, fullVerify, manifest }, null, 2));
} finally {
  await pool.end();
}
