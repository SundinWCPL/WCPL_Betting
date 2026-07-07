import { withTransaction } from '../postgres.js';
import { WUT_LAUNCH_TRINKET_EFFECTS } from '../../services/wutBalanceRules.js';
import { buildOwnedCardData } from './wutPacks.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';

const FAMILIES = Object.keys(WUT_LAUNCH_TRINKET_EFFECTS);
const STARTER_COINS = 1000;
const asNumber = value => Number(value || 0);

async function documents(client) {
  const result = await client.query(`
    SELECT document_key,data FROM app_documents
    WHERE document_key IN ('cards_meta','settings')
  `);
  return Object.fromEntries(result.rows.map(row => [row.document_key, row.data || {}]));
}

export async function joinWutWithClient(client, userId, now = new Date()) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const user = await client.query('SELECT id FROM users WHERE id=$1', [Number(userId)]);
  if (!user.rows[0]) throw new Error('User not found.');
  const existing = await client.query('SELECT 1 FROM wut_memberships WHERE user_id=$1', [Number(userId)]);
  if (existing.rows[0]) throw new Error('You have already joined WUT.');
  const configured = Number(process.env.WUT_JOIN_FEE || 0);
  const joinFee = Number.isFinite(configured) ? Math.max(0, Math.ceil(configured)) : 0;
  if (joinFee > 0) throw new Error('WUT membership cannot be purchased with Mushybux.');
  const membership = {
    user_id: Number(userId), join_fee: joinFee, joined_at: now.toISOString(),
    starter_opened_at: null, starter_card_ids: [], wut_coins: 0, deck_slots: 3
  };
  const order = asNumber((await client.query('SELECT COALESCE(max(source_order), -1) + 1 AS value FROM wut_memberships')).rows[0].value);
  await client.query(`
    INSERT INTO wut_memberships(user_id,wut_coins,source_order,data)
    VALUES($1,0,$2,$3::jsonb)
  `, [Number(userId), order, JSON.stringify(membership)]);
  return {
    joined: true, starterOpened: false, joinFee, joinedAt: membership.joined_at,
    starterOpenedAt: null, starterCardIds: [], wutCoins: 0, deckSlots: 3
  };
}

export async function openWutStarterPackWithClient(client, {
  userId, items, bonusPackItems = null, now = new Date(), random = Math.random
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId, { requireStarter: false });
  if (membership.data?.starter_opened_at) throw new Error('Your WUT starter pack has already been opened.');
  if (!Array.isArray(items) || items.length !== 5) throw new Error('A WUT starter pack must contain exactly five cards.');
  if (items.some(item => item.itemType !== 'player' || item.rolledTier !== 'common')) {
    throw new Error('A WUT starter pack can only contain common player cards.');
  }
  if (items.map(item => String(item.position || '').toUpperCase()).sort().join('') !== 'DDFFG') {
    throw new Error('A WUT starter pack must contain two forwards, two defense, and one goalie.');
  }
  if (new Set(items.map(item => item.cardIdentity || item.catalogKey)).size !== 5) {
    throw new Error('A WUT starter pack cannot contain duplicate cards.');
  }
  const pending = await client.query("SELECT 1 FROM pack_purchases WHERE user_id=$1 AND status='pending'", [Number(userId)]);
  if (pending.rows[0]) throw new Error('Add the pending pack to the collection before opening a starter pack.');
  const docs = await documents(client);
  const cardsConfig = docs.cards_meta?.config || {};
  const week = asNumber(docs.settings?.currentWeek || 1);
  const createdAt = now.toISOString();
  const freeItems = Array.isArray(bonusPackItems) && bonusPackItems.length ? bonusPackItems : [
    ...items.slice(0, 3),
    { itemType: 'boost', boostType: 'goal', rarity: 'common', effect: JSON.parse(JSON.stringify(cardsConfig.boostEffects?.goal?.common || null)) },
    { itemType: 'boost', boostType: 'grit', rarity: 'common', effect: JSON.parse(JSON.stringify(cardsConfig.boostEffects?.grit?.common || null)) }
  ];
  if (freeItems.length !== 5 || freeItems.filter(item => item.itemType === 'player').length !== 3 || freeItems.filter(item => item.itemType === 'boost').length !== 2) {
    throw new Error('The free Starter Standard pack must contain exactly three players and two boosts.');
  }
  const cards = [];
  for (const item of items) {
    const id = asNumber((await client.query("SELECT nextval('owned_cards_id_seq') AS id")).rows[0].id);
    const card = buildOwnedCardData(item, { id, userId, week, createdAt });
    await client.query(`
      INSERT INTO owned_cards(id,user_id,card_identity,edition,source_order,data)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
    `, [id, Number(userId), card.card_identity, card.edition, id, JSON.stringify(card)]);
    cards.push(card);
  }
  const familyPool = [...FAMILIES];
  for (let index = familyPool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [familyPool[index], familyPool[swap]] = [familyPool[swap], familyPool[index]];
  }
  const trinkets = [];
  for (const family of familyPool.slice(0, 2)) {
    const id = asNumber((await client.query("SELECT nextval('owned_trinkets_id_seq') AS id")).rows[0].id);
    const trinket = {
      id, user_id: Number(userId), family, rarity: 'common',
      effect: JSON.parse(JSON.stringify(cardsConfig.wut?.trinketEffects?.[family]?.common ?? WUT_LAUNCH_TRINKET_EFFECTS[family]?.common ?? null)),
      attached_card_id: null, source: 'starter_pack', created_at: createdAt
    };
    await client.query(`
      INSERT INTO owned_trinkets(id,user_id,family,rarity,attached_card_id,source_order,data)
      VALUES($1,$2,$3,'common',NULL,$4,$5::jsonb)
    `, [id, Number(userId), family, id, JSON.stringify(trinket)]);
    trinkets.push(trinket);
  }
  const packId = asNumber((await client.query("SELECT nextval('pack_purchases_id_seq') AS id")).rows[0].id);
  const freePack = {
    id: packId, user_id: Number(userId), week, pack_kind: 'player', pack_type: 'standard',
    price: 0, list_price: asNumber(cardsConfig.playerPackPrices?.standard), free_purchase: true,
    source: 'starter_bonus', items: JSON.parse(JSON.stringify(freeItems)), status: 'pending',
    created_at: createdAt, claimed_at: null
  };
  await client.query(`
    INSERT INTO pack_purchases(id,user_id,status,pack_kind,pack_type,created_at,source_order,data)
    VALUES($1,$2,'pending','player','standard',$3,$4,$5::jsonb)
  `, [packId, Number(userId), createdAt, packId, JSON.stringify(freePack)]);
  membership.data = {
    ...(membership.data || {}),
    starter_card_ids: cards.map(card => card.id),
    starter_trinket_ids: trinkets.map(trinket => trinket.id),
    starter_bonus_pack_id: packId,
    starter_opened_at: createdAt,
    starter_wut_coin_bonus: STARTER_COINS
  };
  const { balance } = await changeWutCoins(client, membership, STARTER_COINS, 'starter_pack_bonus', { pack_purchase_id: packId }, now);
  const deckId = asNumber((await client.query("SELECT nextval('wut_decks_id_seq') AS id")).rows[0].id);
  const deck = {
    id: deckId, user_id: Number(userId), name: 'Starter Deck',
    active_card_ids: cards.map(card => card.id), bench_card_ids: cards.map(card => card.id),
    created_at: createdAt, updated_at: createdAt
  };
  await client.query(`
    INSERT INTO wut_decks(id,user_id,name,source_order,data)
    VALUES($1,$2,'Starter Deck',$3,$4::jsonb)
  `, [deckId, Number(userId), deckId, JSON.stringify(deck)]);
  return {
    cards: cards.map(card => ({ ...card, itemType: 'player' })),
    trinkets,
    freePack,
    deck,
    wutCoins: balance
  };
}

export const joinWutPostgres = (pool, userId, now = new Date()) =>
  withTransaction(pool, client => joinWutWithClient(client, userId, now));
export const openWutStarterPackPostgres = (pool, input) =>
  withTransaction(pool, client => openWutStarterPackWithClient(client, input));
