import assert from 'node:assert/strict';
import { createPostgresPool, runPostgresMigrations } from '../database/postgres.js';
import { adjustWutCoinBalanceWithClient } from '../database/repositories/wutAdmin.js';
import { claimCardsPackWithClient, createCardsPackPurchaseWithClient } from '../database/repositories/wutPacks.js';
import { attachWutTrinketWithClient, removeWutTrinketWithClient } from '../database/repositories/wutTrinkets.js';
import { buyWutTrinketWithClient, rerollWutTrinketShopWithClient } from '../database/repositories/wutShop.js';
import { buyWutDeckSlotWithClient } from '../database/repositories/wutDecks.js';
import { adjustUserBalanceWithClient } from '../database/repositories/walletAdmin.js';
import { claimWutMissionWithClient, getWutMissionsForUserWithClient } from '../database/repositories/wutMissions.js';
import { saveCardsConfigWithClient } from '../database/repositories/cardsAdmin.js';
import { getCardsAdminStatePostgres } from '../database/repositories/cardsRead.js';
import { getPendingCardsPackWithClient } from '../database/repositories/wutRead.js';

const pool = createPostgresPool({ applicationName: 'wcpl-wut-runtime-verifier', max: 2 });
const client = await pool.connect();

try {
  await runPostgresMigrations(pool);
  const candidate = (await pool.query(`
    SELECT m.user_id, m.wut_coins
    FROM wut_memberships m
    WHERE m.data->>'starter_opened_at' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pack_purchases p
        WHERE p.user_id=m.user_id AND p.status IN ('pending','queued')
      )
    ORDER BY m.user_id LIMIT 1
  `)).rows[0];
  if (!candidate) throw new Error('No WUT rehearsal member is eligible for rolled-back pack verification.');
  const before = (await pool.query(`
    SELECT
      (SELECT wut_coins FROM wut_memberships WHERE user_id=$1)::bigint AS coins,
      (SELECT count(*) FROM pack_purchases WHERE user_id=$1)::bigint AS packs,
      (SELECT count(*) FROM owned_cards WHERE user_id=$1)::bigint AS cards,
      (SELECT count(*) FROM owned_boosts WHERE user_id=$1)::bigint AS boosts,
      (SELECT count(*) FROM owned_trinkets WHERE user_id=$1)::bigint AS trinkets,
      (SELECT count(*) FROM wut_transactions WHERE user_id=$1)::bigint AS transactions
  `, [candidate.user_id])).rows[0];

  await client.query('BEGIN');
  const configDocs = Object.fromEntries((await client.query("SELECT document_key,data FROM app_documents WHERE document_key IN ('cards_meta','arena_meta')")).rows.map(row => [row.document_key, row.data]));
  const configInput = JSON.parse(JSON.stringify(configDocs.cards_meta.config));
  configInput.arena = JSON.parse(JSON.stringify(configDocs.arena_meta.config));
  delete configInput.wut.trinketEffects;
  const savedConfig = await saveCardsConfigWithClient(client, configInput);
  assert.equal(savedConfig.config.wut.trinketPrices.legendary, configDocs.cards_meta.config.wut.trinketPrices.legendary);
  const liveAdmin = await getCardsAdminStatePostgres(client);
  assert.equal(liveAdmin.config.wut.trinketPrices.legendary, savedConfig.config.wut.trinketPrices.legendary);
  assert.ok(liveAdmin.wutUsers.some(user => Number(user.userId) === Number(candidate.user_id)));
  await adjustWutCoinBalanceWithClient(client, {
    userId: candidate.user_id, amount: 10000, note: 'Runtime verification'
  });
  await adjustUserBalanceWithClient(client, candidate.user_id, 10000, 'WUT runtime verification');
  await client.query(`
    UPDATE wut_memberships
    SET data=jsonb_set(data, '{deck_slots}', to_jsonb(3), true)
    WHERE user_id=$1
  `, [candidate.user_id]);
  const deckSlot = await buyWutDeckSlotWithClient(client, candidate.user_id, new Date('2099-07-06T11:59:00.000Z'));
  assert.equal(deckSlot.deckSlots, 4);
  const purchasedTrinket = await buyWutTrinketWithClient(client, {
    userId: candidate.user_id, slot: 1, now: new Date('2099-07-06T12:00:00.000Z'), random: () => 0
  });
  assert.ok(purchasedTrinket.id);
  const rerolledShop = await rerollWutTrinketShopWithClient(client, {
    userId: candidate.user_id, currency: 'wut', now: new Date('2099-07-06T12:01:00.000Z'), random: () => 0.25
  });
  assert.equal(rerolledShop.offers.length, 3);
  const liveMissions = await getWutMissionsForUserWithClient(client, {
    userId: candidate.user_id, now: new Date('2099-07-06T12:01:30.000Z')
  });
  assert.equal(liveMissions.daily.length, 3);
  assert.ok(Array.isArray(liveMissions.weekly));
  const missionOrder = Number((await client.query("SELECT COALESCE(max(source_order), -1) + 1 AS value FROM card_records WHERE collection='mission_periods'")).rows[0].value);
  const missionKey = 'runtime-verification';
  const missionRecord = {
    user_id: Number(candidate.user_id), period: 'daily', key: missionKey,
    rotating_id: 'score_200', claimed_ids: [], created_at: '2099-07-06T12:02:00.000Z'
  };
  await client.query(`
    INSERT INTO card_records(collection,record_key,user_id,record_id,source_order,data)
    VALUES('mission_periods',$1,$2,NULL,$3,$4::jsonb)
  `, [`runtime:${candidate.user_id}`, candidate.user_id, missionOrder, JSON.stringify(missionRecord)]);
  const mission = { id: 'play_three', reward: 30, complete: true, claimed: false };
  const missionClaim = await claimWutMissionWithClient(client, {
    userId: candidate.user_id, period: 'daily', periodKey: missionKey, mission,
    now: new Date('2099-07-06T12:03:00.000Z')
  });
  assert.ok(missionClaim.wutCoins > 0);
  await assert.rejects(
    claimWutMissionWithClient(client, { userId: candidate.user_id, period: 'daily', periodKey: missionKey, mission }),
    /already claimed/i
  );
  const items = [
    { itemType: 'player', cardIdentity: 'TEST|F|1', divisionId: 'TEST', playerKey: 'f1', displayName: 'Forward One', edition: 'S3' },
    { itemType: 'player', cardIdentity: 'TEST|D|1', divisionId: 'TEST', playerKey: 'd1', displayName: 'Defense One', edition: 'S3' },
    { itemType: 'player', cardIdentity: 'TEST|G|1', divisionId: 'TEST', playerKey: 'g1', displayName: 'Goalie One', edition: 'S3' },
    { itemType: 'boost', boostType: 'goal', rarity: 'common', effect: { goals: 1 } },
    { itemType: 'boost', boostType: 'grit', rarity: 'common', effect: { hits: 1, blocks: 1 } }
  ];
  const purchase = await createCardsPackPurchaseWithClient(client, {
    userId: candidate.user_id, week: 9995, packKind: 'player', packType: 'standard', price: 100,
    items, now: new Date('2026-07-06T12:30:00.000Z')
  });
  const claimed = await claimCardsPackWithClient(client, {
    userId: candidate.user_id, purchaseId: purchase.id, now: new Date('2026-07-06T12:31:00.000Z')
  });
  assert.equal(claimed.filter(item => item.itemType === 'player').length, 3);
  assert.equal(claimed.filter(item => item.itemType === 'boost').length, 2);
  const queuedId = Number((await client.query("SELECT nextval('pack_purchases_id_seq') AS id")).rows[0].id);
  const queued = { ...purchase, id: queuedId, status: 'queued', price: 0, list_price: 0, source: 'runtime_queue_verification', created_at: '2026-07-06T12:31:15.000Z', claimed_at: null };
  await client.query(`INSERT INTO pack_purchases(id,user_id,status,pack_kind,pack_type,created_at,source_order,data) VALUES($1,$2,'queued','player','standard',$3,$4,$5::jsonb)`, [queuedId,candidate.user_id,queued.created_at,queuedId,JSON.stringify(queued)]);
  assert.equal((await getPendingCardsPackWithClient(client, candidate.user_id)).id, queuedId);
  assert.equal((await client.query('SELECT status FROM pack_purchases WHERE id=$1',[queuedId])).rows[0].status, 'pending');

  const trinketId = Number((await client.query("SELECT nextval('owned_trinkets_id_seq') AS id")).rows[0].id);
  const trinket = {
    id: trinketId, user_id: Number(candidate.user_id), family: 'safety_net', rarity: 'common',
    effect: { threshold: 1 }, attached_card_id: null, source: 'runtime_verification',
    created_at: '2026-07-06T12:31:30.000Z'
  };
  await client.query(`
    INSERT INTO owned_trinkets(id,user_id,family,rarity,attached_card_id,source_order,data)
    VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb)
  `, [trinketId, candidate.user_id, trinket.family, trinket.rarity, trinketId, JSON.stringify(trinket)]);
  const card = claimed.find(item => item.itemType === 'player');
  await attachWutTrinketWithClient(client, {
    userId: candidate.user_id, cardId: card.id, trinketId, cardPosition: 'F',
    now: new Date('2026-07-06T12:32:00.000Z')
  });
  await removeWutTrinketWithClient(client, {
    userId: candidate.user_id, cardId: card.id, currency: 'wut',
    now: new Date('2026-07-06T12:33:00.000Z')
  });
  const detached = await client.query('SELECT attached_card_id, data FROM owned_trinkets WHERE id=$1', [trinketId]);
  assert.equal(detached.rows[0].attached_card_id, null);
  assert.equal(detached.rows[0].data.attached_card_id, null);
  await client.query('ROLLBACK');

  const after = (await pool.query(`
    SELECT
      (SELECT wut_coins FROM wut_memberships WHERE user_id=$1)::bigint AS coins,
      (SELECT count(*) FROM pack_purchases WHERE user_id=$1)::bigint AS packs,
      (SELECT count(*) FROM owned_cards WHERE user_id=$1)::bigint AS cards,
      (SELECT count(*) FROM owned_boosts WHERE user_id=$1)::bigint AS boosts,
      (SELECT count(*) FROM owned_trinkets WHERE user_id=$1)::bigint AS trinkets,
      (SELECT count(*) FROM wut_transactions WHERE user_id=$1)::bigint AS transactions
  `, [candidate.user_id])).rows[0];
  assert.deepStrictEqual(after, before, 'WUT rollback verification changed persistent rehearsal data.');
  console.log(JSON.stringify({
    ok: true,
    wutWalletVerified: true,
    packPurchaseAndClaimVerified: true,
    queuedPrizePackPromotionVerified: true,
    personalTrinketShopVerified: true,
    deckSlotPurchaseVerified: true,
      exactlyOnceMissionClaimVerified: true,
      liveMissionProgressVerified: true,
      adminConfigurationVerified: true,
    trinketAttachmentAndRemovalVerified: true,
    persistentStateUnchanged: true
  }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
