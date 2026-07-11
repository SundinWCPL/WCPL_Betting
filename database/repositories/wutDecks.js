import { withTransaction } from '../postgres.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';
import { lockWutMembership } from './wutWallet.js';
import { validateWutDeckSnapshots } from '../../services/arenaRuntime.js';
import { trinketFitsWutPosition } from '../../services/wutBalanceRules.js';

const asNumber = value => Number(value || 0);
const catalogPlayer = (card, catalog) => catalog?.[card.card_identity] ||
  catalog?.[`${card.edition || 'S3'}|${card.division_id}|${card.player_key}`] ||
  catalog?.[`${card.division_id}|${card.player_key}`] || null;

async function documents(client) {
  const result = await client.query(`
    SELECT document_key,data FROM app_documents
    WHERE document_key IN ('cards_meta','settings')
  `);
  return Object.fromEntries(result.rows.map(row => [row.document_key, row.data || {}]));
}

export async function saveWutDeckWithClient(client, {
  userId, deckId = null, name, activeCardIds, trinketAssignmentIds = {}, catalogByIdentity, now = new Date()
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const cards = (await client.query('SELECT id,data FROM owned_cards WHERE user_id=$1 ORDER BY id FOR UPDATE', [Number(userId)])).rows;
  const owned = new Map(cards.map(row => [Number(row.id), row.data]));
  const trinkets = new Map((await client.query('SELECT id,data FROM owned_trinkets WHERE user_id=$1', [Number(userId)])).rows.map(row => [Number(row.id), row.data]));
  const active = [...new Set((activeCardIds || []).map(Number).filter(Number.isFinite))];
  if (active.some(id => !owned.has(id))) throw new Error('Every deck card must be in your collection.');
  if (active.length) {
    const listingRows = await client.query("SELECT data FROM card_records WHERE collection='trade_listings' AND data->>'status'='active'");
    const listedIds = new Set(listingRows.rows.map(row => Number(row.data?.card_id)).filter(Number.isFinite));
    if (active.some(id => listedIds.has(Number(id)))) throw new Error('Listed trade cards cannot be added to a deck.');
  }
  const docs = await documents(client);
  const wut = docs.cards_meta?.config?.wut || {};
  const rarityCosts = wut.rarityCosts || { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6 };
  const trinketPower = wut.trinketPowerValues || { common: 0, uncommon: 0.5, rare: 1, epic: 1.5, legendary: 2.5 };
  const activeSet = new Set(active);
  const assignments = {};
  const usedTrinkets = new Set();
  for (const [rawCardId, rawTrinketId] of Object.entries(trinketAssignmentIds || {})) {
    const cardId = Number(rawCardId);
    const trinketId = Number(rawTrinketId);
    if (!activeSet.has(cardId) || !trinketId) continue;
    const trinket = trinkets.get(trinketId);
    if (!trinket) throw new Error('Every deck trinket must be in your inventory.');
    if (usedTrinkets.has(trinketId)) throw new Error('A trinket can only be used once in a deck.');
    const player = catalogPlayer(owned.get(cardId), catalogByIdentity);
    if (!trinketFitsWutPosition(trinket.family, player?.position)) throw new Error('That trinket is not legal for that card position.');
    assignments[String(cardId)] = trinketId;
    usedTrinkets.add(trinketId);
  }
  const activeSnapshots = active.map(id => {
    const card = owned.get(id);
    const player = catalogPlayer(card, catalogByIdentity);
    if (!player) throw new Error(`Card #${card.id} is not in the current WUT catalog.`);
    const trinket = trinkets.get(Number(assignments[String(id)])) || null;
    return {
      position: player.position,
      power: asNumber(rarityCosts[player.tier] || 1) + asNumber(trinket ? trinketPower[trinket.rarity] : 0)
    };
  });
  validateWutDeckSnapshots(activeSnapshots, wut, 'Deck');
  let row = deckId == null ? null : (await client.query(
    'SELECT id,data FROM wut_decks WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(deckId), Number(userId)]
  )).rows[0];
  if (!row) {
    const count = asNumber((await client.query('SELECT count(*)::integer AS count FROM wut_decks WHERE user_id=$1', [Number(userId)])).rows[0].count);
    if (count >= asNumber(membership.data?.deck_slots || 3)) throw new Error('Purchase another saved deck slot first.');
    const id = asNumber((await client.query("SELECT nextval('wut_decks_id_seq') AS id")).rows[0].id);
    row = { id, data: { id, user_id: Number(userId), created_at: now.toISOString() }, insert: true };
  }
  const deck = {
    ...(row.data || {}),
    id: asNumber(row.id),
    user_id: Number(userId),
    name: String(name || 'Saved Deck').trim().slice(0, 40) || 'Saved Deck',
    active_card_ids: active,
    trinket_assignments: assignments,
    updated_at: now.toISOString()
  };
  if (row.insert) {
    await client.query(`
      INSERT INTO wut_decks(id,user_id,name,source_order,data)
      VALUES($1,$2,$3,$4,$5::jsonb)
    `, [deck.id, deck.user_id, deck.name, deck.id, JSON.stringify(deck)]);
  } else {
    await client.query('UPDATE wut_decks SET name=$2,data=$3::jsonb WHERE id=$1', [deck.id, deck.name, JSON.stringify(deck)]);
  }
  return deck;
}

export async function buyWutDeckSlotWithClient(client, userId, now = new Date()) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const docs = await documents(client);
  const next = asNumber(membership.data?.deck_slots || 3) + 1;
  const cost = asNumber(docs.cards_meta?.config?.wut?.deckSlotCosts?.[String(next)]);
  if (!cost) throw new Error('You already have the maximum number of deck slots.');
  const user = await lockUser(client, userId);
  await changeLockedUserBalance(client, user, -cost);
  membership.data = { ...(membership.data || {}), deck_slots: next };
  await client.query('UPDATE wut_memberships SET data=$2::jsonb WHERE user_id=$1', [Number(userId), JSON.stringify(membership.data)]);
  await addBalanceTransaction(client, {
    userId, week: asNumber(docs.settings?.currentWeek || 1), amount: -cost,
    kind: 'wut_deck_slot', category: 'cards_convenience', note: `WUT saved deck slot ${next}`,
    createdAt: now.toISOString()
  });
  return { deckSlots: next, cost, balance: asNumber(user.balance) };
}

export const saveWutDeckPostgres = (pool, input) => withTransaction(pool, client => saveWutDeckWithClient(client, input));
export const buyWutDeckSlotPostgres = (pool, userId, now = new Date()) =>
  withTransaction(pool, client => buyWutDeckSlotWithClient(client, userId, now));
