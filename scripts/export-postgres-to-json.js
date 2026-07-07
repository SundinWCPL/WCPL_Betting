import fs from 'node:fs';
import path from 'node:path';
import { createPostgresPool } from '../database/postgres.js';
import { decodeJsonState, stateManifest } from '../database/stateCodec.js';
import { readStateRows } from '../database/stateStore.js';

const outputArg = process.argv.slice(2).find(value => !value.startsWith('--'));
if (!outputArg) throw new Error('Usage: npm run db:export -- <output.json>');
const outputPath = path.resolve(outputArg);
const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
const pool = createPostgresPool({ applicationName: 'wcpl-json-export', max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = await readStateRows(client);
    const state = decodeJsonState(rows);
    const serialized = JSON.stringify(state, null, 2);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(temporaryPath, serialized, 'utf8');
    fs.renameSync(temporaryPath, outputPath);
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, outputPath, bytes: Buffer.byteLength(serialized), manifest: stateManifest(state, rows) }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch {}
  await pool.end();
}
