import { withTransaction } from '../postgres.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';

const SELL_VALUES = { common: 25, uncommon: 50, rare: 100, epic: 150, legendary: 200 };
const asNumber = value => Number(value || 0);

function catalogPlayerForOwnedCard(card, catalogByIdentity) {
  return catalogByIdentity?.[card.card_identity] ||
    catalogByIdentity?.[`${card.edition || 'S3'}|${card.division_id}|${card.player_key}`] ||
    catalogByIdentity?.[`${card.division_id}|${card.player_key}`] || null;
}

async function referencedCardIds(client, userId) {
  const ids = new Set();
  const decks = await client.query('SELECT data FROM wut_decks WHERE user_id=$1', [Number(userId)]);
  const lineups = await client.query("SELECT data FROM card_records WHERE collection='lineups' AND user_id=$1", [Number(userId)]);
  const entries = await client.query("SELECT data FROM arena_entries WHERE user_id=$1 AND status='queued'", [Number(userId)]);
  const matches = await client.query("SELECT data FROM arena_matches WHERE status IN ('drafting','choosing_first','active','scoring','ready')");
  for (const row of decks.rows) for (const id of row.data?.active_card_ids || []) ids.add(Number(id));
  for (const row of lineups.rows) if (Number(row.data?.card_id || 0)) ids.add(Number(row.data.card_id));
  for (const row of entries.rows) for (const card of row.data?.deck_snapshot?.active || []) ids.add(Number(card.card_id));
  for (const row of matches.rows) {
    const match = row.data || {};
    for (const card of match.deck_snapshots?.[String(userId)]?.active || []) ids.add(Number(card.card_id));
    for (const placement of match.placements || []) {
      if (Number(placement.user_id) === Number(userId) && Number(placement.card_id || 0)) ids.add(Number(placement.card_id));
    }
  }
  return ids;
}

export async function sellDuplicatePlayerCardWithClient(client, { userId, cardId, catalogByIdentity = {}, now = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const targetId = Number(cardId);
  const cards = (await client.query('SELECT id,data FROM owned_cards WHERE user_id=$1 ORDER BY id FOR UPDATE', [Number(userId)])).rows;
  const target = cards.find(row => Number(row.id) === targetId)?.data || null;
  if (!target) throw new Error('Card not found in your collection.');
  const identity = String(target.card_identity || '').trim();
  if (!identity) throw new Error('That card cannot be identified.');
  const copies = cards
    .map(row => row.data || {})
    .filter(card => String(card.card_identity || '').trim() === identity)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (copies.length < 2 || Number(copies[0].id) === targetId) throw new Error('Only extra duplicate copies can be sold.');
  const referenced = await referencedCardIds(client, userId);
  if (referenced.has(targetId)) throw new Error('That duplicate card is currently used in a deck, lineup, queue, or active match.');
  if (target.trinket_id != null) throw new Error('That duplicate card still has a legacy trinket attachment.');
  const player = catalogPlayerForOwnedCard(target, catalogByIdentity);
  const rarity = String(player?.tier || '').toLowerCase();
  const amount = asNumber(SELL_VALUES[rarity]);
  if (!amount) throw new Error('That card rarity cannot be sold as a duplicate.');
  await client.query('DELETE FROM owned_cards WHERE id=$1 AND user_id=$2', [targetId, Number(userId)]);
  const { balance } = await changeWutCoins(client, membership, amount, 'duplicate_card_sale', {
    card_id: targetId,
    card_identity: identity,
    rarity
  }, now);
  return { cardId: targetId, cardIdentity: identity, rarity, amount, balance };
}

export const sellDuplicatePlayerCardPostgres = (pool, input) =>
  withTransaction(pool, client => sellDuplicatePlayerCardWithClient(client, input));
