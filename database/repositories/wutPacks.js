import { withTransaction } from '../postgres.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';

const asNumber = value => Number(value || 0);

async function cardsMeta(client) {
  const result = await client.query("SELECT data FROM app_documents WHERE document_key='cards_meta'");
  if (!result.rows[0]) throw new Error('Required PostgreSQL document is missing: cards_meta.');
  return result.rows[0].data || {};
}

export async function createCardsPackPurchaseWithClient(client, {
  userId, week, packKind, packType, price, items, now = new Date()
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const pending = await client.query(
    "SELECT 1 FROM pack_purchases WHERE user_id=$1 AND status IN ('pending','queued') LIMIT 1",
    [Number(userId)]
  );
  if (pending.rows[0]) throw new Error('Reveal your current or queued prize pack before buying another.');
  const cleanPrice = Math.ceil(Number(price || 0));
  if (cleanPrice <= 0) throw new Error('Invalid pack price.');
  if (String(packKind) !== 'player') throw new Error('Separate boost packs were removed in WUT 2.0.');
  if (!Array.isArray(items) || items.length !== 5 || items.filter(item => item.itemType === 'player').length !== 3 || items.filter(item => item.itemType === 'boost').length !== 2) {
    throw new Error('A player pack must contain exactly three players and two boosts.');
  }
  const meta = await cardsMeta(client);
  const freePurchase = meta.config?.wut?.freeShopPurchases === true;
  const chargedPrice = freePurchase ? 0 : cleanPrice;
  if (asNumber(membership.wut_coins) < chargedPrice) throw new Error('Insufficient WUT Coins.');
  if (chargedPrice) await changeWutCoins(client, membership, -chargedPrice, 'player_pack_purchase', { pack_type: String(packType) }, now);
  const id = asNumber((await client.query("SELECT nextval('pack_purchases_id_seq') AS id")).rows[0].id);
  const purchase = {
    id,
    user_id: Number(userId),
    week: Number(week),
    pack_kind: String(packKind),
    pack_type: String(packType),
    price: chargedPrice,
    list_price: cleanPrice,
    free_purchase: freePurchase,
    items: JSON.parse(JSON.stringify(items)),
    status: 'pending',
    created_at: now.toISOString(),
    claimed_at: null
  };
  await client.query(`
    INSERT INTO pack_purchases(id,user_id,status,pack_kind,pack_type,created_at,source_order,data)
    VALUES($1,$2,'pending',$3,$4,$5,$6,$7::jsonb)
  `, [id, Number(userId), String(packKind), String(packType), purchase.created_at, id, JSON.stringify(purchase)]);
  return purchase;
}

export function buildOwnedCardData(item, { id, userId, week, createdAt }) {
  return {
    id,
    user_id: Number(userId),
    division_id: item.divisionId,
    player_key: item.playerKey,
    card_identity: item.cardIdentity || item.catalogKey || `${item.edition || 'S3'}|${item.divisionId}|${item.playerKey}`,
    card_type: item.cardType || item.card_type || 'player',
    card_art: item.cardArt || item.card_art || '',
    edition: item.edition || 'S3',
    source_season: item.sourceSeason || item.source_season || item.edition || 'S3',
    source_stage: item.sourceStage || item.source_stage || 'reg',
    source_team_id: item.sourceTeamId || item.source_team_id || '',
    source_player_key: item.sourcePlayerKey || item.source_player_key || item.playerKey,
    source_steam_id: item.sourceSteamId || item.source_steam_id || '',
    display_name: item.displayName || item.display_name || '',
    acquired_week: Number(week),
    cooldown_remaining: 0,
    retired: false,
    weeks_started: 0,
    total_fp_for_user: 0,
    best_week_fp: 0,
    last_week_fp: 0,
    fantasy_stats: {},
    created_at: createdAt
  };
}

async function markDraftAwardClaimed(client, purchaseId) {
  const events = await client.query('SELECT id, data FROM draft_events FOR UPDATE');
  for (const row of events.rows) {
    let changed = false;
    const data = row.data || {};
    for (const award of data.prizes?.awards || []) {
      if (Number(award.pack_purchase_id) === Number(purchaseId)) {
        award.status = 'claimed';
        changed = true;
      }
    }
    if (changed) await client.query('UPDATE draft_events SET data=$2::jsonb, updated_at=now() WHERE id=$1', [row.id, JSON.stringify(data)]);
  }
}

export async function claimCardsPackWithClient(client, { userId, purchaseId, now = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const result = await client.query('SELECT data FROM pack_purchases WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(purchaseId), Number(userId)]);
  const purchase = result.rows[0]?.data;
  if (!purchase) throw new Error('Pack not found.');
  if (purchase.status !== 'pending') throw new Error('This pack was already added to the collection.');
  const createdAt = now.toISOString();
  const created = [];
  for (const item of purchase.items || []) {
    if (item.itemType === 'player') {
      const id = asNumber((await client.query("SELECT nextval('owned_cards_id_seq') AS id")).rows[0].id);
      const card = buildOwnedCardData(item, { id, userId, week: purchase.week, createdAt });
      await client.query(`
        INSERT INTO owned_cards(id,user_id,card_identity,edition,source_order,data)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)
      `, [id, Number(userId), card.card_identity, card.edition, id, JSON.stringify(card)]);
      created.push({ ...card, itemType: 'player' });
    } else {
      const id = asNumber((await client.query("SELECT nextval('owned_boosts_id_seq') AS id")).rows[0].id);
      const boost = {
        id,
        user_id: Number(userId),
        boost_type: item.boostType,
        rarity: item.rarity,
        effect: item.effect ? JSON.parse(JSON.stringify(item.effect)) : null,
        used_week: null,
        used_slot: '',
        consumed: false,
        created_at: createdAt
      };
      await client.query(`
        INSERT INTO owned_boosts(id,user_id,consumed,source_order,data)
        VALUES($1,$2,false,$3,$4::jsonb)
      `, [id, Number(userId), id, JSON.stringify(boost)]);
      created.push({ ...boost, itemType: 'boost' });
    }
  }
  purchase.status = 'claimed';
  purchase.claimed_at = createdAt;
  await client.query(
    "UPDATE pack_purchases SET status='claimed', data=$2::jsonb WHERE id=$1",
    [purchase.id, JSON.stringify(purchase)]
  );
  await markDraftAwardClaimed(client, purchase.id);
  return created;
}

export const createCardsPackPurchasePostgres = (pool, input) =>
  withTransaction(pool, client => createCardsPackPurchaseWithClient(client, input));
export const claimCardsPackPostgres = (pool, input) =>
  withTransaction(pool, client => claimCardsPackWithClient(client, input));
