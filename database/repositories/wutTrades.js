import { withTransaction } from '../postgres.js';
import { lockWutMembership } from './wutWallet.js';

const asNumber = value => Number(value || 0);
const clone = value => structuredClone(value || {});

function catalogPlayerForOwnedCard(card, catalogByIdentity) {
  return catalogByIdentity?.[card.card_identity] ||
    catalogByIdentity?.[`${card.edition || 'S3'}|${card.division_id}|${card.player_key}`] ||
    catalogByIdentity?.[`${card.division_id}|${card.player_key}`] || null;
}

async function nextRecordId(client, collection) {
  const row = (await client.query(
    'SELECT COALESCE(max(source_order),0)+1 AS id FROM card_records WHERE collection=$1',
    [collection]
  )).rows[0];
  return asNumber(row?.id || 1);
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

async function assertTradeCardAvailable(client, card, catalogByIdentity) {
  if (!card) throw new Error('Card not found in collection.');
  if (card.trinket_id != null) throw new Error('Cards with legacy trinket attachments cannot be traded.');
  if ((await referencedCardIds(client, card.user_id)).has(Number(card.id))) {
    throw new Error('That card is currently used in a deck, lineup, queue, or active match.');
  }
  const rarity = String(catalogPlayerForOwnedCard(card, catalogByIdentity)?.tier || '').toLowerCase();
  if (!rarity) throw new Error('That card is not in the current WUT catalog.');
  return rarity;
}

async function loadTradingRows(client, { lock = false } = {}) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const listings = await client.query(`SELECT record_key,data FROM card_records WHERE collection='trade_listings'${suffix}`);
  const offers = await client.query(`SELECT record_key,data FROM card_records WHERE collection='trade_offers'${suffix}`);
  return {
    listings: listings.rows.map(row => ({ key: row.record_key, data: clone(row.data) })),
    offers: offers.rows.map(row => ({ key: row.record_key, data: clone(row.data) }))
  };
}

function listingView(listing, cardsById, usersById) {
  const card = cardsById.get(Number(listing.card_id)) || null;
  const user = usersById.get(Number(listing.user_id));
  return {
    ...clone(listing),
    card: card ? clone(card) : null,
    owner_display_name: user?.display_name || user?.username || `User #${listing.user_id}`
  };
}

function offerView(offer, listingsById, cardsById, usersById) {
  return {
    ...clone(offer),
    target_listing: listingView(listingsById.get(Number(offer.target_listing_id)) || {}, cardsById, usersById),
    offered_listing: listingView(listingsById.get(Number(offer.offered_listing_id)) || {}, cardsById, usersById)
  };
}

async function tradingStateWithClient(client, userId) {
  const rows = await loadTradingRows(client);
  const cards = await client.query('SELECT data FROM owned_cards');
  const users = await client.query('SELECT id,display_name,username FROM users');
  const cardsById = new Map(cards.rows.map(row => [Number(row.data?.id), clone(row.data)]));
  const usersById = new Map(users.rows.map(row => [Number(row.id), row]));
  const listings = rows.listings.map(row => row.data).filter(item =>
    item.status === 'active' &&
    cardsById.has(Number(item.card_id)) &&
    Number(cardsById.get(Number(item.card_id))?.user_id) === Number(item.user_id)
  );
  const listingsById = new Map(listings.map(item => [Number(item.id), item]));
  const pendingOffers = rows.offers.map(row => row.data).filter(item =>
    item.status === 'pending' &&
    listingsById.has(Number(item.target_listing_id)) &&
    listingsById.has(Number(item.offered_listing_id))
  );
  const targetUserId = Number(userId);
  return {
    ownListings: listings.filter(item => Number(item.user_id) === targetUserId).map(item => listingView(item, cardsById, usersById)),
    marketListings: listings.filter(item => Number(item.user_id) !== targetUserId).map(item => listingView(item, cardsById, usersById)),
    incomingOffers: pendingOffers.filter(item => Number(item.target_user_id) === targetUserId).map(item => offerView(item, listingsById, cardsById, usersById)),
    outgoingOffers: pendingOffers.filter(item => Number(item.requester_user_id) === targetUserId).map(item => offerView(item, listingsById, cardsById, usersById))
  };
}

export const getWutTradingStatePostgres = (pool, userId) =>
  withTransaction(pool, client => tradingStateWithClient(client, userId));

async function saveRecord(client, collection, record, userId = null) {
  await client.query(`
    INSERT INTO card_records(collection,record_key,user_id,record_id,source_order,data)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT(collection,record_key) DO UPDATE SET user_id=EXCLUDED.user_id,record_id=EXCLUDED.record_id,source_order=EXCLUDED.source_order,data=EXCLUDED.data
  `, [collection, String(record.id), userId == null ? null : Number(userId), Number(record.id), Number(record.id), JSON.stringify(record)]);
}

export async function listWutTradeCardWithClient(client, { userId, cardId, catalogByIdentity = {}, now = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const card = (await client.query('SELECT data FROM owned_cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(cardId), Number(userId)])).rows[0]?.data;
  const rarity = await assertTradeCardAvailable(client, card, catalogByIdentity);
  const rows = await loadTradingRows(client, { lock: true });
  if (rows.listings.some(row => row.data.status === 'active' && Number(row.data.card_id) === Number(cardId))) throw new Error('That card is already listed for trade.');
  const id = await nextRecordId(client, 'trade_listings');
  const listing = {
    id, user_id: Number(userId), card_id: Number(card.id), card_identity: String(card.card_identity || ''),
    rarity, status: 'active', created_at: now.toISOString(), closed_at: null
  };
  await saveRecord(client, 'trade_listings', listing, userId);
  return listing;
}

export async function unlistWutTradeCardWithClient(client, { userId, listingId, now = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const rows = await loadTradingRows(client, { lock: true });
  const listingRow = rows.listings.find(row => Number(row.data.id) === Number(listingId) && row.data.status === 'active' && Number(row.data.user_id) === Number(userId));
  if (!listingRow) throw new Error('Trade listing not found.');
  listingRow.data.status = 'cancelled'; listingRow.data.closed_at = now.toISOString();
  await saveRecord(client, 'trade_listings', listingRow.data, userId);
  for (const row of rows.offers.filter(row => row.data.status === 'pending' && [row.data.target_listing_id, row.data.offered_listing_id].map(Number).includes(Number(listingId)))) {
    row.data.status = 'cancelled'; row.data.resolved_at = now.toISOString();
    await saveRecord(client, 'trade_offers', row.data, row.data.requester_user_id);
  }
  return listingRow.data;
}

export async function offerWutTradeWithClient(client, { userId, targetListingId, offeredListingId, catalogByIdentity = {}, now = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const rows = await loadTradingRows(client, { lock: true });
  const target = rows.listings.find(row => Number(row.data.id) === Number(targetListingId) && row.data.status === 'active')?.data;
  const offered = rows.listings.find(row => Number(row.data.id) === Number(offeredListingId) && row.data.status === 'active')?.data;
  if (!target) throw new Error('That trade listing is no longer available.');
  if (!offered || Number(offered.user_id) !== Number(userId)) throw new Error('Choose one of your listed cards to offer.');
  if (Number(target.user_id) === Number(userId)) throw new Error('You cannot offer a trade to yourself.');
  const targetCard = (await client.query('SELECT data FROM owned_cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(target.card_id), Number(target.user_id)])).rows[0]?.data;
  const offeredCard = (await client.query('SELECT data FROM owned_cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(offered.card_id), Number(userId)])).rows[0]?.data;
  const targetRarity = await assertTradeCardAvailable(client, targetCard, catalogByIdentity);
  const offeredRarity = await assertTradeCardAvailable(client, offeredCard, catalogByIdentity);
  if (targetRarity !== offeredRarity) throw new Error('Trades must be 1:1 cards of the same rarity.');
  if (rows.offers.some(row => row.data.status === 'pending' && Number(row.data.target_listing_id) === Number(target.id) && Number(row.data.offered_listing_id) === Number(offered.id))) throw new Error('That trade offer is already pending.');
  const id = await nextRecordId(client, 'trade_offers');
  const offer = {
    id, target_listing_id: Number(target.id), offered_listing_id: Number(offered.id),
    target_user_id: Number(target.user_id), requester_user_id: Number(userId),
    target_card_id: Number(target.card_id), offered_card_id: Number(offered.card_id),
    rarity: targetRarity, status: 'pending', created_at: now.toISOString(), resolved_at: null
  };
  await saveRecord(client, 'trade_offers', offer, userId);
  return offer;
}

export async function resolveWutTradeOfferWithClient(client, { userId, offerId, action, catalogByIdentity = {}, now = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const rows = await loadTradingRows(client, { lock: true });
  const offerRow = rows.offers.find(row => Number(row.data.id) === Number(offerId) && row.data.status === 'pending');
  if (!offerRow) throw new Error('Trade offer not found.');
  const offer = offerRow.data;
  const cleanAction = String(action || '').toLowerCase();
  if (cleanAction === 'cancel') {
    if (Number(offer.requester_user_id) !== Number(userId)) throw new Error('Only the requester can cancel this trade offer.');
    offer.status = 'cancelled'; offer.resolved_at = now.toISOString();
    await saveRecord(client, 'trade_offers', offer, offer.requester_user_id);
    return offer;
  }
  if (Number(offer.target_user_id) !== Number(userId)) throw new Error('Only the receiving user can respond to this trade offer.');
  if (cleanAction === 'decline') {
    offer.status = 'declined'; offer.resolved_at = now.toISOString();
    await saveRecord(client, 'trade_offers', offer, offer.requester_user_id);
    return offer;
  }
  if (cleanAction !== 'accept') throw new Error('Invalid trade response.');
  const targetListing = rows.listings.find(row => Number(row.data.id) === Number(offer.target_listing_id) && row.data.status === 'active')?.data;
  const offeredListing = rows.listings.find(row => Number(row.data.id) === Number(offer.offered_listing_id) && row.data.status === 'active')?.data;
  if (!targetListing || !offeredListing) throw new Error('One of the cards is no longer listed for trade.');
  const targetRow = (await client.query('SELECT id,data FROM owned_cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(offer.target_card_id), Number(offer.target_user_id)])).rows[0];
  const offeredRow = (await client.query('SELECT id,data FROM owned_cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(offer.offered_card_id), Number(offer.requester_user_id)])).rows[0];
  const targetCard = targetRow?.data; const offeredCard = offeredRow?.data;
  const targetRarity = await assertTradeCardAvailable(client, targetCard, catalogByIdentity);
  const offeredRarity = await assertTradeCardAvailable(client, offeredCard, catalogByIdentity);
  if (targetRarity !== offeredRarity || targetRarity !== offer.rarity) throw new Error('Trades must be 1:1 cards of the same rarity.');
  targetCard.user_id = Number(offer.requester_user_id); targetCard.traded_at = now.toISOString(); targetCard.trade_offer_id = Number(offer.id);
  offeredCard.user_id = Number(offer.target_user_id); offeredCard.traded_at = now.toISOString(); offeredCard.trade_offer_id = Number(offer.id);
  await client.query('UPDATE owned_cards SET user_id=$2,data=$3::jsonb WHERE id=$1', [Number(targetCard.id), Number(targetCard.user_id), JSON.stringify(targetCard)]);
  await client.query('UPDATE owned_cards SET user_id=$2,data=$3::jsonb WHERE id=$1', [Number(offeredCard.id), Number(offeredCard.user_id), JSON.stringify(offeredCard)]);
  targetListing.status = 'traded'; targetListing.closed_at = now.toISOString();
  offeredListing.status = 'traded'; offeredListing.closed_at = now.toISOString();
  await saveRecord(client, 'trade_listings', targetListing, targetListing.user_id);
  await saveRecord(client, 'trade_listings', offeredListing, offeredListing.user_id);
  offer.status = 'accepted'; offer.resolved_at = now.toISOString();
  await saveRecord(client, 'trade_offers', offer, offer.requester_user_id);
  for (const row of rows.offers.filter(row => row.data.status === 'pending' && Number(row.data.id) !== Number(offer.id) &&
    [row.data.target_listing_id, row.data.offered_listing_id].some(id => [targetListing.id, offeredListing.id].map(Number).includes(Number(id))))) {
    row.data.status = 'void'; row.data.resolved_at = now.toISOString();
    await saveRecord(client, 'trade_offers', row.data, row.data.requester_user_id);
  }
  return offer;
}

export const listWutTradeCardPostgres = (pool, input) => withTransaction(pool, client => listWutTradeCardWithClient(client, input));
export const unlistWutTradeCardPostgres = (pool, input) => withTransaction(pool, client => unlistWutTradeCardWithClient(client, input));
export const offerWutTradePostgres = (pool, input) => withTransaction(pool, client => offerWutTradeWithClient(client, input));
export const resolveWutTradeOfferPostgres = (pool, input) => withTransaction(pool, client => resolveWutTradeOfferWithClient(client, input));
