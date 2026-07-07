import { withTransaction } from '../postgres.js';
import { WUT_LAUNCH_TRINKET_EFFECTS } from '../../services/wutBalanceRules.js';
import { nextDateKey, zonedDateKey, zonedTimeToDate } from '../../services/zonedTime.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const FAMILIES = Object.keys(WUT_LAUNCH_TRINKET_EFFECTS);
const asNumber = value => Number(value || 0);

async function documents(client) {
  const result = await client.query(`
    SELECT document_key, data FROM app_documents
    WHERE document_key IN ('cards_meta','arena_meta','settings')
  `);
  return Object.fromEntries(result.rows.map(row => [row.document_key, row.data || {}]));
}

function rollWeighted(weights, random) {
  const total = RARITIES.reduce((sum, rarity) => sum + Math.max(0, asNumber(weights?.[rarity])), 0);
  if (total <= 0) throw new Error('Trinket Shop slot needs at least one positive rarity weight.');
  let roll = random() * total;
  for (const rarity of RARITIES) {
    roll -= Math.max(0, asNumber(weights?.[rarity]));
    if (roll < 0) return rarity;
  }
  return RARITIES.at(-1);
}

function buildOffer(config, slot, random) {
  const rarity = rollWeighted(config.trinketShopOdds?.[String(slot)], random);
  const family = FAMILIES[Math.min(FAMILIES.length - 1, Math.floor(random() * FAMILIES.length))];
  return {
    slot,
    family,
    rarity,
    power_cost: asNumber(config.trinketPowerValues?.[rarity]),
    price: asNumber(config.trinketPrices?.[rarity]),
    effect: JSON.parse(JSON.stringify(config.trinketEffects?.[family]?.[rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[family]?.[rarity] ?? null)),
    sold_at: null
  };
}

async function lockShop(client, userId) {
  return (await client.query(`
    SELECT record_key, data FROM card_records
    WHERE collection='trinket_shops' AND user_id=$1
    ORDER BY source_order LIMIT 1 FOR UPDATE
  `, [Number(userId)])).rows[0] || null;
}

async function saveShop(client, userId, existing, shop) {
  if (existing) {
    await client.query(`
      UPDATE card_records SET data=$3::jsonb
      WHERE collection='trinket_shops' AND record_key=$1 AND user_id=$2
    `, [existing.record_key, Number(userId), JSON.stringify(shop)]);
    return;
  }
  const sourceOrder = asNumber((await client.query("SELECT COALESCE(max(source_order), -1) + 1 AS value FROM card_records WHERE collection='trinket_shops'")).rows[0].value);
  await client.query(`
    INSERT INTO card_records(collection,record_key,user_id,record_id,source_order,data)
    VALUES('trinket_shops',$1,$2,NULL,$3,$4::jsonb)
  `, [`${Number(userId)}:${sourceOrder}`, Number(userId), sourceOrder, JSON.stringify(shop)]);
}

async function ensureShop(client, userId, { now, force = false, random = Math.random }) {
  const docs = await documents(client);
  const config = docs.cards_meta?.config?.wut || {};
  const timeZone = docs.arena_meta?.config?.timeZone || 'America/Los_Angeles';
  const dateKey = zonedDateKey(now, timeZone);
  const existing = await lockShop(client, userId);
  const shop = existing?.data || { user_id: Number(userId) };
  if (force || !existing || shop.date_key !== dateKey) {
    shop.date_key = dateKey;
    shop.offers = [1, 2, 3].map(slot => buildOffer(config, slot, random));
    shop.refreshed_at = now.toISOString();
  }
  for (const offer of shop.offers || []) {
    if (offer.effect == null) offer.effect = JSON.parse(JSON.stringify(config.trinketEffects?.[offer.family]?.[offer.rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[offer.family]?.[offer.rarity] ?? null));
    if (!offer.sold_at) offer.price = asNumber(config.trinketPrices?.[offer.rarity]);
  }
  shop.next_refresh_at = zonedTimeToDate(nextDateKey(dateKey), {}, timeZone).toISOString();
  shop.refresh_timezone = timeZone;
  await saveShop(client, userId, existing, shop);
  return { shop, config, settings: docs.settings || {} };
}

export async function buyWutTrinketWithClient(client, { userId, slot, now = new Date(), random = Math.random }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const { shop, config } = await ensureShop(client, userId, { now, random });
  const offer = shop.offers.find(item => Number(item.slot) === Number(slot));
  if (!offer || offer.sold_at) throw new Error('That trinket shop slot is sold out.');
  const chargedPrice = config.freeShopPurchases === true ? 0 : asNumber(offer.price);
  if (asNumber(membership.wut_coins) < chargedPrice) throw new Error('Insufficient WUT Coins.');
  if (chargedPrice) await changeWutCoins(client, membership, -chargedPrice, 'trinket_purchase', {
    shop_slot: Number(slot), trinket_family: offer.family, rarity: offer.rarity
  }, now);
  const id = asNumber((await client.query("SELECT nextval('owned_trinkets_id_seq') AS id")).rows[0].id);
  const trinket = {
    id, user_id: Number(userId), family: offer.family, rarity: offer.rarity,
    effect: JSON.parse(JSON.stringify(config.trinketEffects?.[offer.family]?.[offer.rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[offer.family]?.[offer.rarity] ?? null)),
    attached_card_id: null, created_at: now.toISOString()
  };
  await client.query(`
    INSERT INTO owned_trinkets(id,user_id,family,rarity,attached_card_id,source_order,data)
    VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb)
  `, [id, Number(userId), trinket.family, trinket.rarity, id, JSON.stringify(trinket)]);
  offer.sold_at = now.toISOString();
  offer.owned_trinket_id = id;
  const existing = await lockShop(client, userId);
  await saveShop(client, userId, existing, shop);
  return trinket;
}

export async function rerollWutTrinketShopWithClient(client, {
  userId, currency, now = new Date(), random = Math.random
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const docs = await documents(client);
  const config = docs.cards_meta?.config?.wut || {};
  const kind = currency === 'mushy' ? 'mushy' : 'wut';
  const cost = config.freeShopPurchases === true ? 0 : asNumber(config.shopReroll?.[kind]);
  if (kind === 'wut') {
    if (cost) await changeWutCoins(client, membership, -cost, 'trinket_shop_reroll', {}, now);
  } else if (cost) {
    const user = await lockUser(client, userId);
    await changeLockedUserBalance(client, user, -cost);
    await addBalanceTransaction(client, {
      userId, week: asNumber(docs.settings?.currentWeek || 1), amount: -cost,
      kind: 'wut_shop_reroll', category: 'cards_convenience', note: 'WUT trinket shop reroll',
      createdAt: now.toISOString()
    });
  }
  return (await ensureShop(client, userId, { now, force: true, random })).shop;
}

export async function getWutTrinketShopWithClient(client, { userId, now = new Date(), random = Math.random }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  return ensureShop(client, userId, { now, random });
}

export const buyWutTrinketPostgres = (pool, input) => withTransaction(pool, client => buyWutTrinketWithClient(client, input));
export const rerollWutTrinketShopPostgres = (pool, input) => withTransaction(pool, client => rerollWutTrinketShopWithClient(client, input));
export const getWutTrinketShopPostgres = (pool, input) => withTransaction(pool, client => getWutTrinketShopWithClient(client, input));
