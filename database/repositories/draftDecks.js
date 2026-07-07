import { withTransaction } from '../postgres.js';
import { appendWutDraftEventLog } from '../../services/wutDraftEvents.js';
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

function cardSnapshot(event, inventory, card) {
  const trinket = card.trinket_id == null
    ? null
    : inventory.trinkets.find(item => Number(item.id) === Number(card.trinket_id));
  const rarity = card.rarity || card.player_snapshot?.tier;
  return {
    event_item_id: Number(card.id),
    card_identity: card.card_identity,
    position: card.player_snapshot?.position,
    rarity,
    base_power: rarityPower(event, rarity),
    power: Number(card.power ?? rarityPower(event, rarity)),
    player: clone(card.player_snapshot),
    trinket: trinket ? {
      id: Number(trinket.id), family: trinket.family, rarity: trinket.rarity,
      effect: clone(trinket.effect || {})
    } : null
  };
}

function validateAndStoreDeck(event, userId, activeCardIds, now) {
  const playerId = Number(userId);
  const inventory = inventoryFor(event, playerId);
  const requested = [...new Set((activeCardIds || []).map(Number).filter(Number.isFinite))];
  const minimum = Number(event.config.deckbuilding.activeMinimum);
  const maximum = Number(event.config.deckbuilding.activeMaximum);
  if (requested.length < minimum || requested.length > maximum) {
    throw new Error(`Event Active Deck must contain between ${minimum} and ${maximum} cards.`);
  }
  const cardsById = new Map(inventory.cards.map(card => [Number(card.id), card]));
  const activeCards = requested.map(id => cardsById.get(id));
  if (activeCards.some(card => !card)) throw new Error('The Event Active Deck contains a card outside this temporary collection.');
  const identities = activeCards.map(card => String(card.card_identity || card.player_snapshot?.cardIdentity || ''));
  if (new Set(identities).size !== identities.length) throw new Error('An Event Active Deck cannot contain two copies of the same player card.');
  const benchIds = new Set((inventory.safety_bench_card_ids || []).map(Number));
  if (requested.some(id => benchIds.has(id))) throw new Error('Shared Safety Bench cards cannot be placed in the Event Active Deck.');
  const activeSnapshots = activeCards.map(card => cardSnapshot(event, inventory, card));
  if (activeSnapshots.filter(card => card.trinket?.family === 'team_crest').length > 1) {
    throw new Error("Only one Captain's Patch can be active in an Event lineup.");
  }
  const benchSnapshots = [...benchIds].map(id => cardsById.get(id)).filter(Boolean).map(card => cardSnapshot(event, inventory, card));
  if (event.config.safetyBench.mode !== 'disabled') {
    const positions = benchSnapshots.map(card => card.position).sort().join('');
    if (benchSnapshots.length !== 5 || positions !== 'DDFFG') {
      throw new Error('The shared Event Safety Bench must remain exactly 2F / 2D / 1G.');
    }
  }
  const deck = {
    user_id: playerId,
    active_card_ids: requested,
    safety_bench_card_ids: [...benchIds],
    active_snapshots: activeSnapshots,
    safety_bench_snapshots: benchSnapshots,
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

export async function saveWutDraftEventDeckWithClient(client, { eventId, userId, activeCardIds, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('This Draft Event is paused.');
  const initialBuild = event.phase === 'deckbuilding';
  const sideboarding = event.phase === 'tournament' && event.config.deckbuilding.sideboardingBetweenRounds &&
    !event.config.deckbuilding.lockDeckForTournament && Boolean(event.tournament?.pending_round_plan);
  if (!initialBuild && !sideboarding) throw new Error('Event deckbuilding is not open.');
  if (!activeEntrantIds(event).includes(Number(userId))) throw new Error('Only active Draft Event entrants can submit a deck.');
  const deck = validateAndStoreDeck(event, userId, activeCardIds, now);
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
  if (!canEditTrinkets(event)) throw new Error('Event trinket attachments are locked.');
  const inventory = inventoryFor(event, userId);
  const card = inventory.cards.find(item => Number(item.id) === Number(cardId));
  const trinket = inventory.trinkets.find(item => Number(item.id) === Number(trinketId));
  if (!card || !trinket) throw new Error('That temporary card or trinket is not in your Event Collection.');
  if ((inventory.safety_bench_card_ids || []).map(Number).includes(Number(card.id))) throw new Error('Shared Safety Bench cards cannot receive trinkets.');
  if (card.trinket_id != null) throw new Error('That Event card already has a trinket.');
  if (trinket.attached_card_id != null) throw new Error('That Event trinket is already attached.');
  if (!trinketFitsWutPosition(trinket.family, card.player_snapshot?.position)) throw new Error('That trinket is not legal for this card position.');
  const activeIds = new Set((event.decks?.[String(Number(userId))]?.active_card_ids || []).map(Number));
  if (trinket.family === 'team_crest' && activeIds.has(Number(card.id))) {
    const anotherPatch = inventory.cards.some(other => Number(other.id) !== Number(card.id) && activeIds.has(Number(other.id)) &&
      inventory.trinkets.find(item => Number(item.id) === Number(other.trinket_id))?.family === 'team_crest');
    if (anotherPatch) throw new Error("Only one Captain's Patch can be active in an Event lineup.");
  }
  card.trinket_id = Number(trinket.id);
  trinket.attached_card_id = Number(card.id);
  trinket.attached_at = now.toISOString();
  card.power = rarityPower(event, card.rarity || card.player_snapshot?.tier) + trinketPower(event, trinket.rarity);
  refreshDeck(event, userId, inventory, now);
  appendWutDraftEventLog(event, 'event_trinket_attached', {
    user_id: Number(userId), card_id: Number(card.id), trinket_id: Number(trinket.id)
  }, { actorUserId: userId, now });
  event.updated_at = now.toISOString();
  await saveDraftEvent(client, event);
  return event;
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
