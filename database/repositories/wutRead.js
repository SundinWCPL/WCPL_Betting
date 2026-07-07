import { getWutTrinketShopPostgres } from './wutShop.js';
import { getWutMembershipStatePostgres } from './appRead.js';
import { getWutMissionsForUserPostgres } from './wutMissions.js';
import { withTransaction } from '../postgres.js';

const dataRows = rows => rows.map(row => structuredClone(row.data || {}));

export async function getCardsOwnedStatePostgres(pool, userId) {
  const [cards, boosts] = await Promise.all([
    pool.query('SELECT data FROM owned_cards WHERE user_id=$1 ORDER BY source_order,id', [Number(userId)]),
    pool.query('SELECT data FROM owned_boosts WHERE user_id=$1 ORDER BY source_order,id', [Number(userId)])
  ]);
  return { cards: dataRows(cards.rows), boosts: dataRows(boosts.rows) };
}

export async function getPendingCardsPackWithClient(client, userId) {
    let row = (await client.query(`SELECT id,data FROM pack_purchases WHERE user_id=$1 AND status='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [Number(userId)])).rows[0];
    if (!row) {
      row = (await client.query(`SELECT id,data FROM pack_purchases WHERE user_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [Number(userId)])).rows[0];
      if (row) {
        const purchase = structuredClone(row.data || {}); purchase.status = 'pending'; purchase.promoted_at = new Date().toISOString();
        await client.query("UPDATE pack_purchases SET status='pending',data=$2::jsonb WHERE id=$1", [row.id, JSON.stringify(purchase)]); row.data = purchase;
        const events = await client.query('SELECT id,data FROM draft_events FOR UPDATE');
        for (const eventRow of events.rows) { const event = eventRow.data || {}; const award = (event.prizes?.awards || []).find(item => Number(item.pack_purchase_id) === Number(row.id)); if (!award) continue;
          award.status = 'pending'; await client.query('UPDATE draft_events SET data=$2::jsonb,updated_at=now() WHERE id=$1', [eventRow.id, JSON.stringify(event)]); }
      }
    }
  return row ? structuredClone(row.data || {}) : null;
}
export const getPendingCardsPackPostgres = (pool, userId) => withTransaction(pool, client => getPendingCardsPackWithClient(client, userId));

export async function getWutSystemsStatePostgres(pool, userId, now = new Date()) {
  const [membership, decks, trinkets, cardsMeta, shopState, missions] = await Promise.all([
    getWutMembershipStatePostgres(pool, userId),
    pool.query('SELECT data FROM wut_decks WHERE user_id=$1 ORDER BY source_order,id', [Number(userId)]),
    pool.query('SELECT data FROM owned_trinkets WHERE user_id=$1 ORDER BY source_order,id', [Number(userId)]),
    pool.query("SELECT data FROM app_documents WHERE document_key='cards_meta'"),
    getWutTrinketShopPostgres(pool, { userId, now }),
    getWutMissionsForUserPostgres(pool, { userId, now })
  ]);
  const config = structuredClone(cardsMeta.rows[0]?.data?.config?.wut || {});
  return {
    wutCoins: Number(membership.wutCoins || 0),
    deckSlots: Number(membership.deckSlots || 3),
    nextDeckSlotCost: config.deckSlotCosts?.[String(Number(membership.deckSlots || 3) + 1)] || null,
    decks: dataRows(decks.rows),
    trinkets: dataRows(trinkets.rows),
    shop: structuredClone(shopState.shop),
    missions,
    config
  };
}
