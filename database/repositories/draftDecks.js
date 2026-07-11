import { withTransaction } from '../postgres.js';
import { appendWutDraftEventLog } from '../../services/wutDraftEvents.js';
import { validateWutDeckSnapshots, wutDeckRules } from '../../services/arenaRuntime.js';
import { trinketFitsWutPosition } from '../../services/wutBalanceRules.js';
import { lockAndLoadDraftEvent, saveDraftEvent } from './draftEventStore.js';
import { finishWutDraftDeckbuildingWithClient } from './draftTournament.js';

const clone = value => JSON.parse(JSON.stringify(value));
const DEFAULT_TRINKET_POWER = { common: 0, uncommon: 0.5, rare: 1, epic: 1.5, legendary: 2.5 };

function activeEntrantIds(event) {
  const active = new Set((event.entrants || []).filter(item => item.status === 'active').map(item => Number(item.user_id)));
  const seated = (event.draft?.seat_user_ids || [...active]).map(Number);
  return seated.filter(userId => active.has(userId));
}

function inventoryFor(event, userId) {
  const inventory = event.inventories?.[String(Number(userId))];
  if (!inventory) throw new Error('No temporary Event Collection exists for this player.');
  return inventory;
}

function rarityPower(event, rarity) {
  return Number(event.environment_snapshot?.rules?.rarityCosts?.[rarity] ?? 1);
}

function trinketPower(event, rarity) {
  return Number(event.environment_snapshot?.rules?.trinketPowerValues?.[rarity] ?? DEFAULT_TRINKET_POWER[rarity] ?? 0);
}

function cardSnapshot(event, inventory, card, trinketOverride = undefined) {
  const trinket = trinketOverride === undefined ? (card.trinket_id == null
    ? null
    : inventory.trinkets.find(item => Number(item.id) === Number(card.trinket_id))) : trinketOverride;
  const rarity = card.rarity || card.player_snapshot?.tier;
  const basePower = rarityPower(event, rarity);
  return {
    event_item_id: Number(card.id),
    card_identity: card.card_identity,
    position: card.player_snapshot?.position,
    rarity,
    base_power: basePower,
    power: basePower + (trinket ? trinketPower(event, trinket.rarity) : 0),
    player: clone(card.player_snapshot),
    trinket: trinket ? {
      id: Number(trinket.id), family: trinket.family, rarity: trinket.rarity,
      effect: clone(trinket.effect || {})
    } : null
  };
}

function validateAndStoreDeck(event, userId, activeCardIds, now, trinketAssignmentIds = {}) {
  const playerId = Number(userId);
  const inventory = inventoryFor(event, playerId);
  const requested = [...new Set((activeCardIds || []).map(Number).filter(Number.isFinite))];
  const deckRules = wutDeckRules(event.config.deckbuilding);
  if (requested.length !== deckRules.deckSize) throw new Error(`Event Deck must contain exactly ${deckRules.deckSize} cards.`);
  const cardsById = new Map(inventory.cards.map(card => [Number(card.id), card]));
  const activeCards = requested.map(id => cardsById.get(id));
  if (activeCards.some(card => !card)) throw new Error('The Event Active Deck contains a card outside this temporary collection.');
  const identities = activeCards.map(card => String(card.card_identity || card.player_snapshot?.cardIdentity || ''));
  if (new Set(identities).size !== identities.length) throw new Error('An Event Active Deck cannot contain two copies of the same player card.');
  const activeSet = new Set(requested);
  const assignments = {};
  const usedTrinkets = new Set();
  for (const [rawCardId, rawTrinketId] of Object.entries(trinketAssignmentIds || {})) {
    const cardId = Number(rawCardId);
    const trinketId = Number(rawTrinketId);
    if (!activeSet.has(cardId) || !trinketId) continue;
    const card = cardsById.get(cardId);
    const trinket = inventory.trinkets.find(item => Number(item.id) === trinketId);
    if (!trinket) throw new Error('Every Event Deck trinket must be in your temporary collection.');
    if (usedTrinkets.has(trinketId)) throw new Error('A trinket can only be used once in an Event Deck.');
    if (!trinketFitsWutPosition(trinket.family, card?.player_snapshot?.position)) throw new Error('That trinket is not legal for that card position.');
    assignments[String(cardId)] = trinketId;
    usedTrinkets.add(trinketId);
  }
  const activeSnapshots = activeCards.map(card => cardSnapshot(event, inventory, card, inventory.trinkets.find(item => Number(item.id) === Number(assignments[String(card.id)])) || null));
  validateWutDeckSnapshots(activeSnapshots, event.config.deckbuilding, 'Event Deck');
  const deck = {
    user_id: playerId,
    active_card_ids: requested,
    trinket_assignments: assignments,
    safety_bench_card_ids: [],
    active_snapshots: activeSnapshots,
    safety_bench_snapshots: [],
    submitted_at: now.toISOString(),
    automatic: false,
    locked: Boolean(event.config.deckbuilding.lockDeckForTournament)
  };
  event.decks[String(playerId)] = deck;
  appendWutDraftEventLog(event, 'event_deck_submitted', { user_id: playerId, active_card_ids: requested }, { actorUserId: playerId, now });
  return deck;
}

function canEditTrinkets(event) {
  return event.phase === 'deckbuilding' || (
    event.phase === 'tournament' && Boolean(event.tournament?.pending_round_plan) &&
    !event.config.deckbuilding.lockTrinketAttachments && event.config.deckbuilding.allowTrinketReassignment &&
    event.config.deckbuilding.sideboardingBetweenRounds
  );
}

function refreshDeck(event, userId, inventory, now) {
  const deck = event.decks?.[String(Number(userId))];
  if (!deck) return;
  const cardsById = new Map(inventory.cards.map(card => [Number(card.id), card]));
  deck.active_snapshots = deck.active_card_ids.map(id => cardsById.get(Number(id))).filter(Boolean)
    .map(card => cardSnapshot(event, inventory, card));
  deck.updated_at = now.toISOString();
}

export async function saveWutDraftEventDeckWithClient(client, { eventId, userId, activeCardIds, trinketAssignmentIds = {}, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('This Draft Event is paused.');
  const initialBuild = event.phase === 'deckbuilding';
  const sideboarding = event.phase === 'tournament' && event.config.deckbuilding.sideboardingBetweenRounds &&
    !event.config.deckbuilding.lockDeckForTournament && Boolean(event.tournament?.pending_round_plan);
  if (!initialBuild && !sideboarding) throw new Error('Event deckbuilding is not open.');
  if (!activeEntrantIds(event).includes(Number(userId))) throw new Error('Only active Draft Event entrants can submit a deck.');
  const deck = validateAndStoreDeck(event, userId, activeCardIds, now, trinketAssignmentIds);
  if (sideboarding) appendWutDraftEventLog(event, 'event_deck_sideboarded', {
    user_id: Number(userId), active_card_ids: deck.active_card_ids, round: Number(event.tournament.round)
  }, { actorUserId: userId, now });
  event.updated_at = now.toISOString();
  await saveDraftEvent(client, event);
  const allSubmitted = initialBuild && activeEntrantIds(event).every(id => event.decks[String(id)]);
  const completedEvent = allSubmitted
    ? await finishWutDraftDeckbuildingWithClient(client, { eventId, now })
    : event;
  return { event: completedEvent, deck };
}

export async function attachWutDraftEventTrinketWithClient(client, { eventId, userId, cardId, trinketId, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('This Draft Event is paused.');
  throw new Error('Event trinkets are assigned inside the Event Deck builder now.');
}

export async function detachWutDraftEventTrinketWithClient(client, { eventId, userId, cardId, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('This Draft Event is paused.');
  if (!canEditTrinkets(event)) throw new Error('Event trinket attachments are locked.');
  const inventory = inventoryFor(event, userId);
  const card = inventory.cards.find(item => Number(item.id) === Number(cardId));
  const trinket = card?.trinket_id == null ? null : inventory.trinkets.find(item => Number(item.id) === Number(card.trinket_id));
  if (!card || !trinket) throw new Error('That Event card does not have an attached trinket.');
  card.trinket_id = null;
  card.power = rarityPower(event, card.rarity || card.player_snapshot?.tier);
  trinket.attached_card_id = null;
  trinket.detached_at = now.toISOString();
  refreshDeck(event, userId, inventory, now);
  appendWutDraftEventLog(event, 'event_trinket_detached', {
    user_id: Number(userId), card_id: Number(card.id), trinket_id: Number(trinket.id)
  }, { actorUserId: userId, now });
  event.updated_at = now.toISOString();
  await saveDraftEvent(client, event);
  return event;
}

export const saveWutDraftEventDeckPostgres = (pool, input) => withTransaction(pool, client => saveWutDraftEventDeckWithClient(client, input));
export const attachWutDraftEventTrinketPostgres = (pool, input) => withTransaction(pool, client => attachWutDraftEventTrinketWithClient(client, input));
export const detachWutDraftEventTrinketPostgres = (pool, input) => withTransaction(pool, client => detachWutDraftEventTrinketWithClient(client, input));
