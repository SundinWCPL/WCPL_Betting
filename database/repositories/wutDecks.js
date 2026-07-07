import { withTransaction } from '../postgres.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';
import { lockWutMembership } from './wutWallet.js';

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
  userId, deckId = null, name, activeCardIds, benchCardIds, catalogByIdentity, now = new Date()
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const cards = (await client.query('SELECT id,data FROM owned_cards WHERE user_id=$1 ORDER BY id FOR UPDATE', [Number(userId)])).rows;
  const owned = new Map(cards.map(row => [Number(row.id), row.data]));
  const trinkets = new Map((await client.query('SELECT id,data FROM owned_trinkets WHERE user_id=$1', [Number(userId)])).rows.map(row => [Number(row.id), row.data]));
  const active = [...new Set((activeCardIds || []).map(Number).filter(Number.isFinite))];
  const bench = (benchCardIds || []).map(Number).filter(Number.isFinite);
  if (active.length < 5 || active.length > 8) throw new Error('Active Deck must contain 5 to 8 unique cards.');
  if (bench.length !== 5 || new Set(bench).size !== 5) throw new Error('Safety Bench must contain exactly 5 unique cards.');
  if ([...active, ...bench].some(id => !owned.has(id))) throw new Error('Every deck card must be in your collection.');
  for (const ids of [active, bench]) {
    const identities = ids.map(id => String(owned.get(id).card_identity || ''));
    if (new Set(identities).size !== identities.length) {
      throw new Error(ids === active ? 'Active Deck cannot contain two copies of the same player card.' : 'Safety Bench cannot contain two copies of the same player card.');
    }
  }
  const docs = await documents(client);
  const wut = docs.cards_meta?.config?.wut || {};
  const rarityCosts = wut.rarityCosts || { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6 };
  const trinketPower = wut.trinketPowerValues || { common: 0, uncommon: 0.5, rare: 1, epic: 1.5, legendary: 2.5 };
  const benchSnapshots = bench.map(id => {
    const card = owned.get(id);
    const player = catalogPlayer(card, catalogByIdentity);
    if (!player) throw new Error(`Card #${card.id} is not in the current WUT catalog.`);
    const trinket = card.trinket_id ? trinkets.get(Number(card.trinket_id)) : null;
    return {
      position: player.position,
      power: asNumber(rarityCosts[player.tier] || 1) + asNumber(trinket ? trinketPower[trinket.rarity] : 0)
    };
  });
  if (benchSnapshots.map(card => card.position).sort().join('') !== 'DDFFG') {
    throw new Error('Safety Bench must be exactly 2F / 2D / 1G.');
  }
  if (benchSnapshots.some(card => card.power > 2)) throw new Error('Every Safety Bench card must be Power 2 or lower.');
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
    bench_card_ids: bench,
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
