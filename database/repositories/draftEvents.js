import { withTransaction } from '../postgres.js';
import {
  appendWutDraftEventLog,
  createWutDraftEventRecord,
  normalizeWutDraftEventConfig,
  pauseWutDraftEventRecord,
  resumeWutDraftEventRecord,
  transitionWutDraftEventRecord,
  wutPacificDateTimeToIso
} from '../../services/wutDraftEvents.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';
import { insertDraftEvent, lockAndLoadDraftEvent, saveDraftEvent } from './draftEventStore.js';

const asNumber = value => Number(value || 0);

async function requireAdmin(client, adminUserId) {
  const result = await client.query('SELECT role FROM users WHERE id=$1', [Number(adminUserId)]);
  if (result.rows[0]?.role !== 'admin') throw new Error('Admin access is required for WUT Draft Event controls.');
}

export async function createWutDraftEventWithClient(client, {
  config = null, presetId = null, adminUserId, now = new Date()
}) {
  await requireAdmin(client, adminUserId);
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242999]);
  let preset = null;
  if (presetId != null) {
    preset = (await client.query('SELECT data FROM draft_presets WHERE id=$1', [Number(presetId)])).rows[0]?.data;
    if (!preset) throw new Error('WUT Draft Event preset not found.');
  }
  const eventConfig = config || preset?.config;
  if (!eventConfig) throw new Error('Draft event configuration is required.');
  const id = asNumber((await client.query("SELECT nextval('draft_events_id_seq') AS id")).rows[0].id);
  const event = createWutDraftEventRecord({
    id, config: normalizeWutDraftEventConfig(eventConfig), presetId: preset?.id || null, adminUserId, now
  });
  if (preset) appendWutDraftEventLog(event, 'preset_loaded', {
    preset_id: preset.id, preset_name: preset.name
  }, { actorUserId: adminUserId, now });
  await insertDraftEvent(client, event);
  return event;
}

export async function getWutDraftEventPresetsPostgres(pool) {
  const rows = (await pool.query('SELECT data FROM draft_presets ORDER BY source_order,id')).rows.map(row => row.data || {});
  return rows.sort((a, b) => Number(Boolean(b.system)) - Number(Boolean(a.system)) || String(a.name || '').localeCompare(String(b.name || '')));
}

export async function saveWutDraftEventPresetWithClient(client, { presetId = null, name, description = '', config, adminUserId, now = new Date() }) {
  await requireAdmin(client, adminUserId); const normalized = normalizeWutDraftEventConfig(config); const cleanName = String(name || normalized.basic.name || '').trim().slice(0, 100);
  if (!cleanName) throw new Error('Preset name is required.'); let preset = null;
  if (presetId != null) { preset = (await client.query('SELECT data FROM draft_presets WHERE id=$1 FOR UPDATE', [Number(presetId)])).rows[0]?.data; if (preset?.system) throw new Error('System presets cannot be overwritten. Save a new preset instead.'); }
  if (!preset) { const id = Number((await client.query("SELECT nextval('draft_presets_id_seq') AS id")).rows[0].id); preset = { id, key: null, system: false, created_by: Number(adminUserId), created_at: now.toISOString() }; }
  preset.name = cleanName; preset.description = String(description || '').trim().slice(0, 1000); preset.config = normalized; preset.updated_at = now.toISOString();
  await client.query(`INSERT INTO draft_presets(id,preset_key,source_order,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET preset_key=EXCLUDED.preset_key,data=EXCLUDED.data`, [preset.id,preset.key,Number(preset.id),JSON.stringify(preset)]);
  return preset;
}

async function chargeEntry(client, event, userId, now) {
  const { currency, amount } = event.config.basic.entryFee;
  const paid = asNumber(amount);
  if (currency === 'free' || paid <= 0) return { currency: 'free', amount: 0, transaction_id: null };
  if (currency === 'wut_coin') {
    const membership = await lockWutMembership(client, userId);
    const result = await changeWutCoins(client, membership, -paid, 'draft_event_entry', { draft_event_id: event.id }, now);
    return { currency, amount: paid, transaction_id: result.transaction.id };
  }
  const user = await lockUser(client, userId);
  await changeLockedUserBalance(client, user, -paid);
  const settings = (await client.query("SELECT data FROM app_documents WHERE document_key='settings'")).rows[0]?.data || {};
  const transaction = await addBalanceTransaction(client, {
    userId, week: asNumber(settings.currentWeek || 1), amount: -paid,
    kind: 'draft_event_entry', category: 'cards', draft_event_id: event.id,
    note: `Entry to ${event.config.basic.name}`, createdAt: now.toISOString()
  });
  return { currency, amount: paid, transaction_id: transaction.id };
}

export async function refundEntrant(client, event, entrant, reason, now) {
  if (!entrant || entrant.refunded_at || asNumber(entrant.payment?.amount) <= 0) return 0;
  const amount = asNumber(entrant.payment.amount);
  if (entrant.payment.currency === 'wut_coin') {
    const membership = await lockWutMembership(client, entrant.user_id, { requireStarter: false });
    const result = await changeWutCoins(client, membership, amount, 'draft_event_refund', {
      draft_event_id: event.id, reason
    }, now);
    entrant.refund_transaction_id = result.transaction.id;
  } else if (entrant.payment.currency === 'mushybux') {
    const user = await lockUser(client, entrant.user_id);
    await changeLockedUserBalance(client, user, amount);
    const settings = (await client.query("SELECT data FROM app_documents WHERE document_key='settings'")).rows[0]?.data || {};
    const transaction = await addBalanceTransaction(client, {
      userId: user.id, week: asNumber(settings.currentWeek || 1), amount,
      kind: 'draft_event_refund', category: 'cards', draft_event_id: event.id,
      note: `Refund for ${event.config.basic.name}: ${reason}`, createdAt: now.toISOString()
    });
    entrant.refund_transaction_id = transaction.id;
  }
  entrant.refunded_at = now.toISOString();
  entrant.refund_reason = reason;
  return amount;
}

export async function joinWutDraftEventWithClient(client, { eventId, userId, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('This Draft Event is paused.');
  const late = event.phase === 'signup_closed' && event.config.signup.allowLateSignup;
  if (event.phase !== 'signup_open' && !late) throw new Error('Signup is not open for this Draft Event.');
  await lockWutMembership(client, userId);
  if ((event.entrants || []).some(item => Number(item.user_id) === Number(userId) && item.status === 'active')) {
    throw new Error('You are already entered in this Draft Event.');
  }
  const activeCount = event.entrants.filter(item => item.status === 'active').length;
  if (event.config.basic.maximumEntrants != null && activeCount >= Number(event.config.basic.maximumEntrants)) {
    throw new Error('This Draft Event is full.');
  }
  const payment = await chargeEntry(client, event, userId, now);
  event.entrants.push({
    user_id: Number(userId), status: 'active', joined_at: now.toISOString(), withdrawn_at: null,
    dropped_at: null, payment, refunded_at: null, refund_transaction_id: null
  });
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, late ? 'player_joined_late' : 'player_joined', {
    user_id: Number(userId), payment
  }, { actorUserId: userId, now });
  await saveDraftEvent(client, event);
  return event;
}

export async function withdrawWutDraftEventWithClient(client, { eventId, userId, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'signup_open' || !event.config.signup.allowWithdrawal) {
    throw new Error('Withdrawal is not available for this Draft Event.');
  }
  const entrant = event.entrants.find(item => Number(item.user_id) === Number(userId) && item.status === 'active');
  if (!entrant) throw new Error('You are not entered in this Draft Event.');
  entrant.status = 'withdrawn';
  entrant.withdrawn_at = now.toISOString();
  const refunded = await refundEntrant(client, event, entrant, 'Player withdrew before signup closed', now);
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'player_withdrew', { user_id: Number(userId), refunded }, { actorUserId: userId, now });
  await saveDraftEvent(client, event);
  return event;
}

export async function transitionWutDraftEventWithClient(client, {
  eventId, nextPhase, adminUserId, system = false, reason = '', now = new Date()
}) {
  if (!system) await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (nextPhase === 'starting') throw new Error('Draft Events must start through the frozen environment snapshot flow.');
  if (event.phase === 'tournament' && nextPhase === 'complete') throw new Error('Resolve the tournament through its round controls before completing the event.');
  if (nextPhase === 'cancelled' && event.paused_at) {
    event.paused_at = null;
    appendWutDraftEventLog(event, 'pause_overridden_for_cancellation', {}, { actorUserId: adminUserId, now });
  }
  transitionWutDraftEventRecord(event, nextPhase, { actorUserId: adminUserId, reason, now });
  if (nextPhase === 'cancelled') {
    let refunded = 0;
    for (const entrant of event.entrants.filter(item => item.status === 'active')) {
      entrant.status = 'cancelled';
      entrant.cancelled_at = now.toISOString();
      refunded += await refundEntrant(client, event, entrant, reason || 'Draft Event cancelled', now);
    }
    for (const match of event.tournament?.matches || []) {
      if (!['completed', 'voided', 'cancelled'].includes(match.status)) {
        match.status = 'cancelled';
        match.cancelled_at = now.toISOString();
        match.cancel_reason = 'event_cancelled';
      }
    }
    appendWutDraftEventLog(event, 'event_cancelled_refunds', { refunded }, { actorUserId: adminUserId, now });
  }
  await saveDraftEvent(client, event);
  return event;
}

export async function rescheduleWutDraftEventWithClient(client, { eventId, adminUserId, signupOpensAt = null, signupClosesAt = null, startsAt = null, now = new Date() }) {
  await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId);
  if (!['scheduled','signup_open','signup_closed'].includes(event.phase)) throw new Error('Only an upcoming Draft Event can be rescheduled.');
  const parse = (value, label) => value == null || String(value).trim() === '' ? null : wutPacificDateTimeToIso(value, label);
  const next = { signupOpensAt: parse(signupOpensAt, 'Signup opening'), signupClosesAt: parse(signupClosesAt, 'Signup closing'), startsAt: parse(startsAt, 'Event start') };
  const ordered = Object.values(next).filter(Boolean).map(value => new Date(value).getTime());
  if (ordered.some((value, index) => index && value < ordered[index - 1])) throw new Error('Signup opening, signup closing, and event start must be in chronological order.');
  event.config.scheduling = { ...event.config.scheduling, ...next }; event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'event_rescheduled', next, { actorUserId: adminUserId, now }); await saveDraftEvent(client, event); return event;
}

export async function pauseWutDraftEventWithClient(client, { eventId, adminUserId, reason = '', now = new Date() }) {
  await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId);
  pauseWutDraftEventRecord(event, { actorUserId: adminUserId, reason, now }); await saveDraftEvent(client, event); return event;
}

export async function resumeWutDraftEventWithClient(client, { eventId, adminUserId, now = new Date() }) {
  await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId);
  resumeWutDraftEventRecord(event, { actorUserId: adminUserId, now }); await saveDraftEvent(client, event); return event;
}

export const createWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => createWutDraftEventWithClient(client, input));
export const joinWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => joinWutDraftEventWithClient(client, input));
export const withdrawWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => withdrawWutDraftEventWithClient(client, input));
export const transitionWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => transitionWutDraftEventWithClient(client, input));
export const rescheduleWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => rescheduleWutDraftEventWithClient(client, input));
export const pauseWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => pauseWutDraftEventWithClient(client, input));
export const resumeWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => resumeWutDraftEventWithClient(client, input));
export const saveWutDraftEventPresetPostgres = (pool, input) => withTransaction(pool, client => saveWutDraftEventPresetWithClient(client, input));
