import { withTransaction } from '../postgres.js';
import {
  appendWutDraftEventLog,
  buildWutDraftBoosterRoundTemplates,
  chooseWutDraftAutopick,
  materializeWutDraftBoosterRound,
  transitionWutDraftEventRecord
} from '../../services/wutDraftEvents.js';
import { lockAndLoadDraftEvent, saveDraftEvent } from './draftEventStore.js';

const clone = value => JSON.parse(JSON.stringify(value));

async function requireAdmin(client, userId) {
  const result = await client.query('SELECT role FROM users WHERE id=$1', [Number(userId)]);
  if (result.rows[0]?.role !== 'admin') throw new Error('Admin access is required for WUT Draft Event controls.');
}

function ensureInventories(event) {
  for (const entrant of (event.entrants || []).filter(item => item.status === 'active')) {
    const key = String(entrant.user_id);
    event.inventories[key] = {
      cards: [], boosts: [], trinkets: [], safety_bench_card_ids: [],
      ...(event.inventories[key] || {})
    };
  }
}

export async function startWutDraftEventWithClient(client, {
  eventId, environment, adminUserId, system = false, startNow = false, now = new Date()
}) {
  if (!system) await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('Resume the event before changing phases.');
  const closeNow = startNow && ['scheduled', 'signup_open'].includes(event.phase);
  if (event.phase !== 'signup_closed' && !closeNow) throw new Error('A Draft Event can only start after signup closes.');
  if (event.environment_snapshot) throw new Error('This Draft Event already has a frozen environment snapshot.');
  const entrants = event.entrants.filter(item => item.status === 'active');
  if (entrants.length < Number(event.config.basic.minimumEntrants) && !event.config.basic.allowManualStartBelowMinimum) {
    throw new Error(`This event needs at least ${event.config.basic.minimumEntrants} entrants.`);
  }
  if (!event.config.basic.allowOddEntrants && entrants.length % 2) throw new Error('This event requires an even number of entrants.');
  if (!environment || !Array.isArray(environment.cards)) throw new Error('A valid frozen WUT environment is required.');
  const frozen = clone(environment);
  if (closeNow) transitionWutDraftEventRecord(event, 'signup_closed', {
    actorUserId: adminUserId, reason: 'Signup closed for an early admin start', now
  });
  event.environment_snapshot = { ...frozen, captured_at: now.toISOString() };
  ensureInventories(event);
  transitionWutDraftEventRecord(event, 'starting', { actorUserId: adminUserId, reason: 'Environment frozen', now });
  appendWutDraftEventLog(event, 'environment_snapshotted', { card_count: frozen.cards.length }, { actorUserId: adminUserId, now });
  await saveDraftEvent(client, event);
  return event;
}

function setDeadline(event, now) {
  event.draft.deadline_at = new Date(now.getTime() + Number(event.config.draft.pickSeconds) * 1000).toISOString();
  event.deadlines.draft_pick = event.draft.deadline_at;
}

function prepareAutopicks(event, now, random = Math.random) {
  if (!event.config.draft.autopick.enabled) {
    event.draft.prepared_autopicks = {};
    return;
  }
  const prepared = {};
  for (const userId of event.draft.pending_user_ids || []) {
    const playerId = Number(userId);
    const pack = event.draft.boosters.find(item => Number(item.booster_number) === Number(event.draft.current_booster) &&
      Number(item.current_owner_user_id) === playerId && !item.awaiting_pass && item.items.length);
    const item = chooseWutDraftAutopick(pack?.items || [], event.config.draft.autopick.priority, random);
    if (!pack || !item) continue;
    prepared[String(playerId)] = {
      user_id: playerId,
      pack_id: Number(pack.id),
      item_id: Number(item.id),
      booster_number: Number(event.draft.current_booster),
      pick_number: Number(event.draft.current_pick),
      prepared_at: now.toISOString()
    };
  }
  event.draft.prepared_autopicks = prepared;
}

function generateRound(event, boosterNumber, packs, now, random = Math.random) {
  const template = event.draft.round_templates.find(item => Number(item.boosterNumber) === Number(boosterNumber));
  const materialized = packs.map(pack => ({
    ...pack, id: Number(event.nextDraftPackId++), opened_at: now.toISOString(),
    items: pack.items.map(item => ({ ...item, id: Number(event.nextDraftItemId++) }))
  }));
  event.draft.boosters.push(...materialized);
  event.draft.current_booster = boosterNumber;
  event.draft.current_pick = 1;
  event.draft.pending_user_ids = [...event.draft.seat_user_ids];
  setDeadline(event, now);
  prepareAutopicks(event, now, random);
  appendWutDraftEventLog(event, 'booster_generated', {
    booster_number: boosterNumber,
    pack_ids: materialized.map(pack => pack.id),
    composition: template.slots.map(slot => ({ item_type: slot.itemType, rarity: slot.rarity })),
    direction: template.passDirection
  }, { now });
}

export async function beginWutDraftEventWithClient(client, {
  eventId, adminUserId, system = false, now = new Date(), random = Math.random
}) {
  if (!system) await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase === 'starting') transitionWutDraftEventRecord(event, 'draft', {
    actorUserId: adminUserId, reason: 'Draft started by administrator', now
  });
  if (event.phase !== 'draft') throw new Error('The event must be in its draft phase before boosters are generated.');
  if (!event.draft.round_templates?.length) {
    ensureInventories(event);
    const templates = buildWutDraftBoosterRoundTemplates(event.config, random);
    const seats = event.entrants.filter(item => item.status === 'active').map(item => Number(item.user_id));
    const packs = materializeWutDraftBoosterRound({
      template: templates[0], entrantIds: seats, cards: event.environment_snapshot.cards,
      boostEffects: event.environment_snapshot.rules?.boostEffects || {},
      trinketEffects: event.environment_snapshot.rules?.trinketEffects || {},
      poolRules: event.config.boosters.pool, usedCardIdentities: new Set(), random
    });
    event.draft.round_templates = templates;
    event.draft.seat_user_ids = seats;
    event.draft.boosters = [];
    event.draft.picks = [];
    event.draft.pass_log = [];
    generateRound(event, 1, packs, now, random);
    appendWutDraftEventLog(event, 'draft_started', { seats, booster_count: templates.length }, { actorUserId: adminUserId, now });
  }
  await saveDraftEvent(client, event);
  return event;
}

function temporaryItem(event, item, userId, now) {
  const base = {
    id: Number(event.nextTemporaryItemId++), item_type: item.item_type, rarity: item.rarity,
    source: 'booster_draft', drafted_by_user_id: Number(userId), drafted_at: now.toISOString()
  };
  if (item.item_type === 'player') return {
    ...base, card_identity: item.card_identity, player_snapshot: clone(item.player_snapshot),
    power: Number(event.environment_snapshot.rules?.rarityCosts?.[item.rarity] || 1)
  };
  if (item.item_type === 'boost') return { ...base, boost_type: item.boost_type, effect: clone(item.effect || {}), consumed: false };
  return { ...base, family: item.family, effect: clone(item.effect || {}), attached_card_id: null };
}

function passPacks(event, now, random = Math.random) {
  const packs = event.draft.boosters.filter(pack => Number(pack.booster_number) === Number(event.draft.current_booster));
  if (packs.every(pack => !pack.items.length)) {
    for (const pack of packs) {
      pack.emptied_at ||= now.toISOString();
      pack.awaiting_pass = false;
    }
    if (event.draft.current_booster < event.draft.round_templates.length) {
      const nextNumber = event.draft.current_booster + 1;
      const template = event.draft.round_templates.find(item => Number(item.boosterNumber) === Number(nextNumber));
      const used = new Set(event.draft.boosters.flatMap(pack => [
        ...(pack.items || []).filter(item => item.item_type === 'player').map(item => item.card_identity),
        ...(pack.history || []).filter(item => item.item?.item_type === 'player').map(item => item.item.card_identity)
      ]).filter(Boolean));
      const nextPacks = materializeWutDraftBoosterRound({
        template, entrantIds: event.draft.seat_user_ids, cards: event.environment_snapshot.cards,
        boostEffects: event.environment_snapshot.rules?.boostEffects || {},
        trinketEffects: event.environment_snapshot.rules?.trinketEffects || {},
        poolRules: event.config.boosters.pool, usedCardIdentities: used, random
      });
      generateRound(event, nextNumber, nextPacks, now, random);
      return;
    }
    event.draft.completed_at = now.toISOString();
    event.draft.deadline_at = null;
    event.draft.pending_user_ids = [];
    event.draft.prepared_autopicks = {};
    delete event.deadlines.draft_pick;
    transitionWutDraftEventRecord(event, 'deckbuilding', { reason: 'All boosters exhausted', now });
    event.deckbuilding.deadline_at = new Date(now.getTime() + Number(event.config.deckbuilding.seconds) * 1000).toISOString();
    event.deadlines.deckbuilding = event.deckbuilding.deadline_at;
    appendWutDraftEventLog(event, 'draft_completed', { pick_count: event.draft.picks.length }, { now });
    return;
  }
  const seats = event.draft.seat_user_ids;
  const direction = packs[0]?.pass_direction || 'left';
  for (const pack of packs) {
    const previous = Number(pack.current_owner_user_id);
    const index = seats.indexOf(previous);
    const next = Number(seats[(index + (direction === 'right' ? -1 : 1) + seats.length) % seats.length]);
    pack.current_owner_user_id = next;
    pack.awaiting_pass = false;
    pack.pass_count = Number(pack.pass_count || 0) + 1;
    event.draft.pass_log.push({
      booster_number: event.draft.current_booster, pick_number: event.draft.current_pick,
      pack_id: pack.id, from_user_id: previous, to_user_id: next, direction, passed_at: now.toISOString()
    });
  }
  event.draft.current_pick += 1;
  event.draft.pending_user_ids = [...seats];
  setDeadline(event, now);
  prepareAutopicks(event, now, random);
}

function commitDraftPick(event, { userId, itemId, autopick = false, now = new Date(), random = Math.random }) {
  const playerId = Number(userId);
  if (!event.draft.seat_user_ids.map(Number).includes(playerId)) throw new Error('Only Draft Event entrants can pick.');
  if (event.paused_at || event.phase !== 'draft' || event.draft.completed_at) throw new Error('The Booster Draft is not active.');
  if (!event.draft.pending_user_ids.map(Number).includes(playerId)) throw new Error('You have already picked for this pass step.');
  const pack = event.draft.boosters.find(item => Number(item.booster_number) === Number(event.draft.current_booster) &&
    Number(item.current_owner_user_id) === playerId && !item.awaiting_pass && item.items.length);
  if (!pack) throw new Error('No active booster is assigned to this player.');
  const index = pack.items.findIndex(item => Number(item.id) === Number(itemId));
  if (index < 0) throw new Error('That item is not available in your current booster.');
  const [item] = pack.items.splice(index, 1);
  const inventory = event.inventories[String(playerId)];
  const drafted = temporaryItem(event, item, playerId, now);
  if (drafted.item_type === 'player') inventory.cards.push(drafted);
  else if (drafted.item_type === 'boost') inventory.boosts.push(drafted);
  else inventory.trinkets.push(drafted);
  pack.awaiting_pass = true;
  const pick = {
    number: event.draft.picks.length + 1, booster_number: event.draft.current_booster,
    pick_number: event.draft.current_pick, pack_id: pack.id, user_id: playerId,
    item: clone(item), temporary_item_id: drafted.id, autopick: Boolean(autopick), picked_at: now.toISOString()
  };
  pack.history.push(pick);
  event.draft.picks.push(pick);
  event.draft.pending_user_ids = event.draft.pending_user_ids.filter(id => Number(id) !== playerId);
  if (event.draft.prepared_autopicks) delete event.draft.prepared_autopicks[String(playerId)];
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, autopick ? 'item_autopicked' : 'item_drafted', {
    user_id: playerId, pack_id: pack.id, booster_number: pick.booster_number,
    pick_number: pick.pick_number, item_id: item.id, item_type: item.item_type, rarity: item.rarity
  }, { actorUserId: playerId, now });
  if (!event.draft.pending_user_ids.length) passPacks(event, now, random);
  return pick;
}

export async function pickWutDraftItemWithClient(client, { eventId, userId, itemId, autopick = false, now = new Date(), random = Math.random }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  const pick = commitDraftPick(event, { userId, itemId, autopick, now, random });
  await saveDraftEvent(client, event);
  return { event, pick };
}

export async function forceWutDraftAutopickWithClient(client, { eventId, userId = null, adminUserId = null, system = false, now = new Date(), random = Math.random }) {
  if (!system) await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'draft' || event.paused_at) throw new Error('The Booster Draft is not active.');
  const targets = userId == null ? [...event.draft.pending_user_ids] : [Number(userId)];
  const picks = [];
  for (const target of targets) {
    if (!event.draft.pending_user_ids.map(Number).includes(Number(target))) continue;
    const pack = event.draft.boosters.find(item => Number(item.booster_number) === Number(event.draft.current_booster) &&
      Number(item.current_owner_user_id) === Number(target) && !item.awaiting_pass);
    const prepared = event.draft.prepared_autopicks?.[String(Number(target))] || null;
    const preparedItem = prepared && Number(prepared.pack_id) === Number(pack?.id) &&
      Number(prepared.booster_number) === Number(event.draft.current_booster) &&
      Number(prepared.pick_number) === Number(event.draft.current_pick)
      ? pack?.items.find(item => Number(item.id) === Number(prepared.item_id))
      : null;
    const item = preparedItem || chooseWutDraftAutopick(pack?.items || [], event.config.draft.autopick.priority, random);
    if (!item) continue;
    picks.push(commitDraftPick(event, { userId: target, itemId: item.id, autopick: true, now, random }));
  }
  await saveDraftEvent(client, event);
  return { event, picks };
}

export async function extendWutDraftPickDeadlineWithClient(client, { eventId, adminUserId, seconds, now = new Date() }) {
  await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'draft' || !event.draft.deadline_at) throw new Error('A Booster Draft pick timer is not active.');
  const amount = Math.max(1, Math.min(86400, Math.round(Number(seconds) || 0)));
  event.draft.deadline_at = new Date(new Date(event.draft.deadline_at).getTime() + amount * 1000).toISOString();
  event.deadlines.draft_pick = event.draft.deadline_at;
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'draft_timer_extended', { seconds: amount, deadline_at: event.draft.deadline_at }, { actorUserId: adminUserId, now });
  await saveDraftEvent(client, event);
  return event;
}

export const startWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => startWutDraftEventWithClient(client, input));
export const beginWutDraftEventPostgres = (pool, input) => withTransaction(pool, client => beginWutDraftEventWithClient(client, input));
export const pickWutDraftItemPostgres = (pool, input) => withTransaction(pool, client => pickWutDraftItemWithClient(client, input));
export const forceWutDraftAutopickPostgres = (pool, input) => withTransaction(pool, client => forceWutDraftAutopickWithClient(client, input));
export const extendWutDraftPickDeadlinePostgres = (pool, input) => withTransaction(pool, client => extendWutDraftPickDeadlineWithClient(client, input));
