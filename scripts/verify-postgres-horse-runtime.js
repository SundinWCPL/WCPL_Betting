import assert from 'node:assert/strict';
import { createPostgresPool, runPostgresMigrations } from '../database/postgres.js';
import { adjustUserBalanceWithClient } from '../database/repositories/walletAdmin.js';
import { getHorseRaceSchedule } from '../services/horseRacing.js';
import {
  addHorseRaceChatMessageWithClient,
  buyHorseWithClient,
  claimHorseOwnerWinningsWithClient,
  controlCurrentHorseRaceWithClient,
  getHorseRaceStateForUserWithClient,
  placeOrUpdateHorseRaceBetWithClient,
  processCurrentHorseRaceWithClient,
  settleHorseRaceWithClient
} from '../database/repositories/horseRacing.js';
import { lockAndLoadHorseStore, saveHorseStore } from '../database/repositories/horseStore.js';

const pool = createPostgresPool({ applicationName: 'wcpl-horse-runtime-verifier', max: 2 });
const client = await pool.connect();

async function snapshot(userId) {
  return (await pool.query(`
    SELECT
      (SELECT balance FROM users WHERE id=$1)::bigint AS balance,
      (SELECT count(*) FROM balance_transactions WHERE user_id=$1)::bigint AS transactions,
      (SELECT data FROM app_documents WHERE document_key='horse_meta') AS horse_meta,
      (SELECT data FROM app_documents WHERE document_key='horse_chat_meta') AS horse_chat_meta,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'type', entity_type, 'key', entity_key, 'user', user_id, 'order', source_order, 'data', data
      ) ORDER BY entity_type, source_order), '[]'::jsonb) FROM horse_entities) AS entities
  `, [userId])).rows[0];
}

try {
  await runPostgresMigrations(pool);
  const candidate = (await pool.query(`
    SELECT u.id, u.balance
    FROM users u
    LEFT JOIN horse_entities h ON h.entity_type='horse' AND h.user_id=u.id
    GROUP BY u.id, u.balance
    HAVING count(h.*) < 3
    ORDER BY u.id LIMIT 1
  `)).rows[0];
  if (!candidate) throw new Error('No rehearsal user can own another horse.');
  const before = await snapshot(candidate.id);
  await client.query('BEGIN');
  await adjustUserBalanceWithClient(client, candidate.id, 10000, 'Horse runtime verification');
  const scheduledRace = await processCurrentHorseRaceWithClient(client, new Date('2098-07-06T18:00:00.000Z'));
  assert.ok(scheduledRace?.id);
  const chatNow = new Date(getHorseRaceSchedule('2098-07-06', 1).bettingOpensAt.getTime() + 60000);
  assert.equal((await controlCurrentHorseRaceWithClient(client, 'open', chatNow)).status, 'betting');
  const message = await addHorseRaceChatMessageWithClient(client, {
    userId: candidate.id, username: 'Runtime', message: 'Rollback check', now: chatNow
  });
  assert.equal(message.message, 'Rollback check');
  assert.equal((await controlCurrentHorseRaceWithClient(client, 'close', new Date(chatNow.getTime() + 1000))).status, 'countdown');
  assert.equal((await controlCurrentHorseRaceWithClient(client, 'start', new Date(chatNow.getTime() + 2000))).status, 'racing');
  assert.equal((await controlCurrentHorseRaceWithClient(client, 'reset', new Date(chatNow.getTime() + 3000))).status, 'upcoming');
  const horse = await buyHorseWithClient(client, {
    userId: candidate.id, name: 'Runtime Rollback', now: new Date('2026-07-06T13:00:00.000Z')
  });
  const loaded = await lockAndLoadHorseStore(client);
  const race = {
    id: Number(loaded.store.nextRaceId || 1), race_date: '2099-01-01', race_number: 1,
    status: 'betting', settled_at: null, horse_names: [{ id: horse.id, name: horse.name }],
    created_at: '2026-07-06T13:00:30.000Z', updated_at: '2026-07-06T13:00:30.000Z'
  };
  loaded.store.nextRaceId = race.id + 1;
  loaded.store.races.push(race);
  await saveHorseStore(client, loaded.store);
  const placed = await placeOrUpdateHorseRaceBetWithClient(client, {
    userId: candidate.id, horseId: horse.id, stake: 10, now: new Date('2026-07-06T13:01:00.000Z')
  });
  assert.equal(placed.action, 'placed');
  const updated = await placeOrUpdateHorseRaceBetWithClient(client, {
    userId: candidate.id, horseId: horse.id, stake: 20, now: new Date('2026-07-06T13:02:00.000Z')
  });
  assert.equal(updated.action, 'updated');
  assert.equal(updated.bet.stake, 20);
  const liveState = await getHorseRaceStateForUserWithClient(client, {
    userId: candidate.id, now: new Date('2026-07-06T13:02:30.000Z')
  });
  assert.equal(typeof liveState.balanceSummary.available_balance, 'number');
  assert.ok(Array.isArray(liveState.race.horses));
  assert.ok(Array.isArray(liveState.pastResults));

  const settlementState = await lockAndLoadHorseStore(client);
  const settlementRace = settlementState.store.races.find(item => Number(item.id) === Number(race.id));
  settlementRace.finishing_order = [horse.id];
  assert.equal(await settleHorseRaceWithClient(client, {
    store: settlementState.store,
    settings: settlementState.settings,
    race: settlementRace,
    now: new Date('2026-07-06T13:03:00.000Z')
  }), true);
  const generatedReward = settlementState.store.ownerRewards.find(item =>
    Number(item.race_id) === Number(race.id) && String(item.horse_id) === String(horse.id)
  );
  assert.ok(generatedReward?.amount > 0);
  const claimed = await claimHorseOwnerWinningsWithClient(client, {
    userId: candidate.id, horseId: horse.id, now: new Date('2026-07-06T13:04:00.000Z')
  });
  assert.deepStrictEqual(claimed, {
    horseId: horse.id, horseName: horse.name, rewards: 1, amount: generatedReward.amount
  });
  await client.query('ROLLBACK');
  assert.deepStrictEqual(await snapshot(candidate.id), before, 'Horse runtime rollback changed persistent rehearsal data.');
  console.log(JSON.stringify({
    ok: true,
    horsePurchaseVerified: true,
    scheduledRaceProcessingVerified: true,
    chatAndAdminControlsVerified: true,
    horseBetPlaceAndUpdateVerified: true,
    raceSettlementAndPayoutVerified: true,
    ownerClaimVerified: true,
    liveHorseStateVerified: true,
    persistentStateUnchanged: true
  }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
