import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPostgresPool } from '../database/postgres.js';
import { decodeJsonState, stateManifest } from '../database/stateCodec.js';
import { readStateRows } from '../database/stateStore.js';

const sourceArg = process.argv.slice(2).find(value => !value.startsWith('--'));
if (!sourceArg) throw new Error('Usage: npm run db:verify -- <source-betting.json>');
const sourcePath = path.resolve(sourceArg);
const raw = fs.readFileSync(sourcePath);
const source = JSON.parse(raw.toString('utf8'));
const pool = createPostgresPool({ applicationName: 'wcpl-import-verify', max: 1 });

try {
  const rows = await readStateRows(pool);
  const restored = decodeJsonState(rows);
  assert.deepStrictEqual(restored, source, 'PostgreSQL data differs from the source JSON.');
  const sourceSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const importRun = (await pool.query('SELECT * FROM import_runs ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(importRun?.source_sha256, sourceSha256, 'Latest import SHA-256 does not match this source file.');
  console.log(JSON.stringify({ ok: true, sourcePath, sourceSha256, manifest: stateManifest(restored, rows) }, null, 2));
} finally {
  await pool.end();
}
