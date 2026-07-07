import fs from 'node:fs/promises';
import path from 'node:path';
import { readStateRows } from './stateStore.js';
import { decodeJsonState } from './stateCodec.js';

export async function serializePostgresState(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = decodeJsonState(await readStateRows(client));
    await client.query('COMMIT');
    return { state, json: JSON.stringify(state, null, 2) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function createPostgresJsonBackup(pool, {
  directory = process.env.BACKUP_DIR || path.resolve('./backups'),
  now = new Date()
} = {}) {
  const { state, json } = await serializePostgresState(pool);
  const safeIso = now.toISOString().replace(/[:.]/g, '-');
  const week = Number(state.settings?.currentWeek || 1);
  const filename = `betting-week-${week}-${safeIso}.json`;
  const fullPath = path.join(path.resolve(directory), filename);
  const temporaryPath = `${fullPath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, json, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporaryPath, fullPath);
  } catch (error) {
    try { await fs.unlink(temporaryPath); } catch {}
    throw error;
  }
  return { filename, fullPath, backupDir: path.dirname(fullPath), bytes: Buffer.byteLength(json) };
}
