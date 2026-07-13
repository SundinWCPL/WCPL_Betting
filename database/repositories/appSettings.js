import { withTransaction } from '../postgres.js';
import { autoClaimCompletedWeeklyMissionsWithClient } from './wutMissions.js';

async function lockSettings(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242029]);
  const row = (await client.query("SELECT data FROM app_documents WHERE document_key='settings' FOR UPDATE")).rows[0];
  if (!row) throw new Error('Required PostgreSQL document is missing: settings.');
  return { ...(row.data || {}) };
}

async function saveSettings(client, settings) {
  await client.query("UPDATE app_documents SET data=$1::jsonb WHERE document_key='settings'", [JSON.stringify(settings)]);
  return settings;
}

export async function patchSettingsWithClient(client, patch) {
  const settings = await lockSettings(client);
  Object.assign(settings, patch);
  return saveSettings(client, settings);
}

export async function setWeekLockedWithClient(client, week, locked) {
  const settings = await lockSettings(client);
  const target = Number(week);
  const values = new Set((settings.lockedWeeks || []).map(Number));
  if (locked) values.add(target); else values.delete(target);
  settings.lockedWeeks = [...values].sort((a, b) => a - b);
  settings.bettingLocked = settings.lockedWeeks.includes(Number(settings.currentWeek || 1));
  return saveSettings(client, settings);
}

export async function setMaintenanceModeWithClient(client, enabled, message = '', now = new Date()) {
  const settings = await lockSettings(client);
  const next = Boolean(enabled);
  settings.maintenanceMode = next;
  settings.maintenanceMessage = String(message || settings.maintenanceMessage ||
    'WCPL Betting is temporarily offline for scheduled maintenance.').trim().slice(0, 500);
  settings.maintenanceStartedAt = next ? now.toISOString() : null;
  return saveSettings(client, settings);
}

export async function advanceWeekWithClient(client) {
  const missionAutoClaims = await autoClaimCompletedWeeklyMissionsWithClient(client);
  const settings = await lockSettings(client);
  settings.currentWeek = Number(settings.currentWeek || 1) + 1;
  const locked = new Set((settings.lockedWeeks || []).map(Number));
  locked.delete(settings.currentWeek); locked.delete(settings.currentWeek + 1);
  settings.lockedWeeks = [...locked].sort((a, b) => a - b);
  settings.bettingLocked = false;
  const saved = await saveSettings(client, settings);
  return { ...saved, missionAutoClaims };
}

export const setMaintenanceModePostgres = (pool, enabled, message = '', now = new Date()) =>
  withTransaction(pool, client => setMaintenanceModeWithClient(client, enabled, message, now));
export const patchSettingsPostgres = (pool, patch) => withTransaction(pool, client => patchSettingsWithClient(client, patch));
export const setWeekLockedPostgres = (pool, week, locked) => withTransaction(pool, client => setWeekLockedWithClient(client, week, locked));
export const advanceWeekPostgres = pool => withTransaction(pool, client => advanceWeekWithClient(client));
