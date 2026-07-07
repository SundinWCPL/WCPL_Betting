import assert from 'node:assert/strict';
import { createPostgresPool, runPostgresMigrations } from '../database/postgres.js';
import { spinCasinoSlotsWithClient } from '../database/repositories/casinoSlots.js';
import {
  cancelOpenBetWithClient,
  placeOrUpdateSeriesBetWithClient,
  settleBetsWithClient,
  voidBetByIdWithClient
} from '../database/repositories/sportsbook.js';
import {
  adjustUserBalanceWithClient,
  applyWeeklyAllowanceWithClient
} from '../database/repositories/walletAdmin.js';
import {
  startShotDoctorRunWithClient,
  submitShotDoctorGuessWithClient
} from '../database/repositories/shotDoctor.js';
import { adjustWutCoinBalanceWithClient } from '../database/repositories/wutAdmin.js';
import {
  claimCardsPackWithClient,
  createCardsPackPurchaseWithClient
} from '../database/repositories/wutPacks.js';
import {
  attachWutTrinketWithClient,
  removeWutTrinketWithClient
} from '../database/repositories/wutTrinkets.js';
import {
  getAdminSettingsPostgres,
  getPendingWutDraftActionEventIdsPostgres,
  getUserByIdPostgres,
  getWutMembershipStatePostgres,
  hasPendingArenaTurnPostgres
} from '../database/repositories/appRead.js';
import { setMaintenanceModeWithClient } from '../database/repositories/appSettings.js';
import { getAdminBetsForWeekPostgres, getCasinoSummaryPostgres, getUserSummariesPostgres } from '../database/repositories/adminRead.js';
import { getLeaderboardsPostgres, getTopWeeklyBetsPostgres, getUserSettledBetHistoryPostgres, getWeeklyBetTotalByTeamPostgres } from '../database/repositories/homeRead.js';
import { getOddsAdjustmentsForWeekPostgres, saveSeriesOddsForWeekWithClient } from '../database/repositories/oddsAdmin.js';

const pool = createPostgresPool({ applicationName: 'wcpl-runtime-verifier', max: 2 });
const client = await pool.connect();

try {
  await runPostgresMigrations(pool);
  console.log('Runtime verifier: connected and migrations are current.');
  const candidate = (await pool.query('SELECT id, balance FROM users WHERE balance >= 10 ORDER BY id LIMIT 1')).rows[0];
  if (!candidate) throw new Error('No rehearsal user has enough balance for a rolled-back slot verification.');
  const runtimeUser = await getUserByIdPostgres(pool, candidate.id);
  assert.equal(runtimeUser.id, Number(candidate.id));
  assert.equal(runtimeUser.balance, Number(candidate.balance));
  assert.equal(Object.hasOwn(runtimeUser, 'password_hash'), false);
  const runtimeSettings = await getAdminSettingsPostgres(pool);
  assert.ok(Number.isFinite(runtimeSettings.currentWeek));
  const runtimeMembership = await getWutMembershipStatePostgres(pool, candidate.id);
  assert.equal(typeof runtimeMembership.joined, 'boolean');
  assert.equal(typeof await hasPendingArenaTurnPostgres(pool, candidate.id), 'boolean');
  assert.ok(Array.isArray(await getPendingWutDraftActionEventIdsPostgres(pool, candidate.id)));
  assert.ok(Array.isArray(await getUserSummariesPostgres(pool)));
  assert.ok(Array.isArray(await getAdminBetsForWeekPostgres(pool, runtimeSettings.currentWeek, ['open','settled'])));
  assert.equal(typeof (await getCasinoSummaryPostgres(pool)).totalWagered, 'number');
  const leaderboards = await getLeaderboardsPostgres(pool, runtimeSettings.currentWeek);
  assert.ok(leaderboards.betting.length && leaderboards.overall.length);
  assert.ok(Array.isArray(await getWeeklyBetTotalByTeamPostgres(pool, runtimeSettings.currentWeek)));
  assert.ok(Array.isArray(await getTopWeeklyBetsPostgres(pool, runtimeSettings.currentWeek)));
  assert.ok(Array.isArray(await getUserSettledBetHistoryPostgres(pool, candidate.id)));
  const before = (await pool.query(`
    SELECT
      (SELECT balance FROM users WHERE id = $1)::bigint AS balance,
      (SELECT count(*) FROM casino_spins WHERE user_id = $1)::bigint AS spins,
      (SELECT count(*) FROM balance_transactions WHERE user_id = $1)::bigint AS transactions,
      (SELECT data FROM app_documents WHERE document_key = 'casino_meta') AS casino
  `, [candidate.id])).rows[0];

  await client.query('BEGIN');
  await saveSeriesOddsForWeekWithClient(client, { week: 9994, seriesKey: 'runtime-series', marketKeys: ['runtime-market'], multipliers: [2], goalTotalLine: 10.5, goalTotalBoost: 1.5 });
  assert.equal((await getOddsAdjustmentsForWeekPostgres(client, 9994)).series['runtime-market'], 2);
  await client.query('ROLLBACK');

  await client.query('BEGIN');
  const maintenance = await setMaintenanceModeWithClient(client, true, 'Runtime rollback verification', new Date('2026-07-06T11:59:00.000Z'));
  assert.equal(maintenance.maintenanceMode, true);
  assert.equal(maintenance.maintenanceMessage, 'Runtime rollback verification');
  await client.query('ROLLBACK');

  await client.query('BEGIN');
  const spin = await spinCasinoSlotsWithClient(client, {
    userId: candidate.id,
    wager: 10,
    now: new Date('2026-07-06T12:00:00.000Z'),
    random: () => 0
  });
  assert.equal(spin.outcome_key, 'loss');
  assert.equal(spin.balanceSummary.available_balance, Number(candidate.balance) - 10);
  await client.query('ROLLBACK');

  const after = (await pool.query(`
    SELECT
      (SELECT balance FROM users WHERE id = $1)::bigint AS balance,
      (SELECT count(*) FROM casino_spins WHERE user_id = $1)::bigint AS spins,
      (SELECT count(*) FROM balance_transactions WHERE user_id = $1)::bigint AS transactions,
      (SELECT data FROM app_documents WHERE document_key = 'casino_meta') AS casino
  `, [candidate.id])).rows[0];
  assert.deepStrictEqual(after, before, 'Rolled-back runtime verification changed persistent rehearsal data.');
  console.log('Runtime verifier: slot transaction rollback passed.');

  await client.query('BEGIN');
  await client.query(`
    UPDATE app_documents
    SET data=jsonb_set(data, '{currentWeek}', to_jsonb(9995), true)
    WHERE document_key='settings'
  `);
  const shots = Array.from({ length: 10 }, (_, index) => ({
    shooter_name: `Shooter ${index + 1}`, goalie_name: 'Goalie', shot_type: 'Wrist',
    speed_kmh: 80, distance_m: 10, x: 0, z: 0, xg: 0.5, result: 'G'
  }));
  const runStartedAt = new Date('2026-07-06T12:00:00.000Z');
  const started = await startShotDoctorRunWithClient(client, {
    userId: candidate.id, shots, wager: 10, now: runStartedAt
  });
  let guessResult;
  for (let index = 0; index < 10; index += 1) {
    guessResult = await submitShotDoctorGuessWithClient(client, {
      userId: candidate.id,
      runId: started.run.id,
      guess: 'G',
      now: new Date(runStartedAt.getTime() + (index + 1) * 1000)
    });
  }
  assert.equal(guessResult.run.status, 'complete');
  assert.equal(guessResult.run.correct, 10);
  assert.equal(guessResult.run.payout, 500);
  assert.equal(guessResult.balanceSummary.available_balance, Number(candidate.balance) + 490);
  await client.query('ROLLBACK');
  console.log('Runtime verifier: Puck IQ lifecycle and payout rollback passed.');

  await client.query('BEGIN');
  const placed = await placeOrUpdateSeriesBetWithClient(client, {
    userId: candidate.id, week: 9999, divisionId: 'TEST', seriesKey: 'runtime-verification',
    marketKey: 'test-home', marketType: 'moneyline', teamId: 'TEST', label: 'Runtime verification',
    stake: 10, multiplier: 2
  });
  assert.equal(placed.action, 'placed');
  const updated = await placeOrUpdateSeriesBetWithClient(client, {
    userId: candidate.id, week: 9999, divisionId: 'TEST', seriesKey: 'runtime-verification',
    marketKey: 'test-away', marketType: 'moneyline', teamId: 'AWAY', label: 'Runtime verification updated',
    stake: 20, multiplier: 3
  });
  assert.deepStrictEqual(updated, { id: placed.id, action: 'updated' });
  const cancelled = await cancelOpenBetWithClient(client, { userId: candidate.id, betId: placed.id });
  assert.equal(cancelled.refunded, 20);
  const inside = (await client.query(`
    SELECT
      (SELECT balance FROM users WHERE id=$1)::bigint AS balance,
      (SELECT count(*) FROM bets WHERE id=$2)::bigint AS bets,
      (SELECT count(*) FROM balance_transactions WHERE data->>'bet_id'=$2::text)::bigint AS transactions
  `, [candidate.id, placed.id])).rows[0];
  assert.equal(Number(inside.balance), Number(candidate.balance));
  assert.equal(Number(inside.bets), 0);
  assert.equal(Number(inside.transactions), 0);
  await client.query('ROLLBACK');
  console.log('Runtime verifier: sportsbook place/update/cancel passed.');

  await client.query('BEGIN');
  const settlementBet = await placeOrUpdateSeriesBetWithClient(client, {
    userId: candidate.id, week: 9998, divisionId: 'TEST', seriesKey: 'runtime-settlement',
    marketKey: 'winner', marketType: 'moneyline', teamId: 'TEST', label: 'Runtime settlement',
    stake: 10, multiplier: 2
  });
  const settlement = await settleBetsWithClient(client, {
    week: 9998,
    results: { evaluations: { [settlementBet.id]: { ready: true, won: true, result_summary: 'verified' } } }
  });
  assert.deepStrictEqual(settlement, { settled: 1, winners: 1, losers: 0, payoutTotal: 20, skipped: 0 });
  const settledBalance = await client.query('SELECT balance FROM users WHERE id=$1', [candidate.id]);
  assert.equal(Number(settledBalance.rows[0].balance), Number(candidate.balance) + 10);
  await client.query('ROLLBACK');
  console.log('Runtime verifier: sportsbook settlement passed.');

  await client.query('BEGIN');
  const voidBet = await placeOrUpdateSeriesBetWithClient(client, {
    userId: candidate.id, week: 9997, divisionId: 'TEST', seriesKey: 'runtime-void',
    marketKey: 'winner', marketType: 'moneyline', teamId: 'TEST', label: 'Runtime void',
    stake: 10, multiplier: 2
  });
  assert.deepStrictEqual(await voidBetByIdWithClient(client, voidBet.id, 'Runtime verification'), { count: 1, refunded: 10 });
  await adjustUserBalanceWithClient(client, candidate.id, 5, 'Runtime verification');
  const adjustedBalance = await client.query('SELECT balance FROM users WHERE id=$1', [candidate.id]);
  assert.equal(Number(adjustedBalance.rows[0].balance), Number(candidate.balance) + 5);
  await client.query('ROLLBACK');
  console.log('Runtime verifier: sportsbook void and admin wallet adjustment passed.');

  await client.query('BEGIN');
  const allowance = await applyWeeklyAllowanceWithClient(client, 9996);
  assert.ok(allowance.count > 0);
  assert.equal((await applyWeeklyAllowanceWithClient(client, 9996)).count, 0);
  await client.query('ROLLBACK');
  console.log('Runtime verifier: idempotent weekly allowance passed.');

  if (process.argv.includes('--include-wut')) {
  const wutCandidate = (await pool.query(`
    SELECT m.user_id, m.wut_coins
    FROM wut_memberships m
    WHERE m.data->>'starter_opened_at' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pack_purchases p
        WHERE p.user_id=m.user_id AND p.status IN ('pending','queued')
      )
    ORDER BY m.user_id LIMIT 1
  `)).rows[0];
  if (!wutCandidate) throw new Error('No WUT rehearsal member is eligible for rolled-back pack verification.');
  await client.query('BEGIN');
  await adjustWutCoinBalanceWithClient(client, {
    userId: wutCandidate.user_id, amount: 1000, note: 'Runtime verification'
  });
  const packItems = [
    { itemType: 'player', cardIdentity: 'TEST|F|1', divisionId: 'TEST', playerKey: 'f1', displayName: 'Forward One', edition: 'S3' },
    { itemType: 'player', cardIdentity: 'TEST|D|1', divisionId: 'TEST', playerKey: 'd1', displayName: 'Defense One', edition: 'S3' },
    { itemType: 'player', cardIdentity: 'TEST|G|1', divisionId: 'TEST', playerKey: 'g1', displayName: 'Goalie One', edition: 'S3' },
    { itemType: 'boost', boostType: 'goal', rarity: 'common', effect: { goals: 1 } },
    { itemType: 'boost', boostType: 'grit', rarity: 'common', effect: { hits: 1, blocks: 1 } }
  ];
  const purchase = await createCardsPackPurchaseWithClient(client, {
    userId: wutCandidate.user_id, week: 9995, packKind: 'player', packType: 'standard',
    price: 100, items: packItems, now: new Date('2026-07-06T12:30:00.000Z')
  });
  const claimed = await claimCardsPackWithClient(client, {
    userId: wutCandidate.user_id, purchaseId: purchase.id, now: new Date('2026-07-06T12:31:00.000Z')
  });
  assert.equal(claimed.filter(item => item.itemType === 'player').length, 3);
  assert.equal(claimed.filter(item => item.itemType === 'boost').length, 2);
  const wutInside = await client.query('SELECT wut_coins FROM wut_memberships WHERE user_id=$1', [wutCandidate.user_id]);
  assert.equal(Number(wutInside.rows[0].wut_coins), Number(wutCandidate.wut_coins) + 1000 - purchase.price);
  const trinketId = Number((await client.query("SELECT nextval('owned_trinkets_id_seq') AS id")).rows[0].id);
  const testTrinket = {
    id: trinketId, user_id: Number(wutCandidate.user_id), family: 'safety_net', rarity: 'common',
    effect: { threshold: 1 }, attached_card_id: null, source: 'runtime_verification',
    created_at: '2026-07-06T12:31:30.000Z'
  };
  await client.query(`
    INSERT INTO owned_trinkets(id,user_id,family,rarity,attached_card_id,source_order,data)
    VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb)
  `, [trinketId, wutCandidate.user_id, testTrinket.family, testTrinket.rarity, trinketId, JSON.stringify(testTrinket)]);
  const testCard = claimed.find(item => item.itemType === 'player');
  await attachWutTrinketWithClient(client, {
    userId: wutCandidate.user_id, cardId: testCard.id, trinketId, cardPosition: 'F',
    now: new Date('2026-07-06T12:32:00.000Z')
  });
  const removal = await removeWutTrinketWithClient(client, {
    userId: wutCandidate.user_id, cardId: testCard.id, currency: 'wut',
    now: new Date('2026-07-06T12:33:00.000Z')
  });
  assert.ok(removal.cost >= 0);
  const detached = await client.query('SELECT attached_card_id, data FROM owned_trinkets WHERE id=$1', [trinketId]);
  assert.equal(detached.rows[0].attached_card_id, null);
  assert.equal(detached.rows[0].data.attached_card_id, null);
  await client.query('ROLLBACK');
  console.log('Runtime verifier: WUT wallet, pack, and trinket attachment/removal rollback passed.');
  }

  const finalState = (await pool.query(`
    SELECT
      (SELECT balance FROM users WHERE id = $1)::bigint AS balance,
      (SELECT count(*) FROM casino_spins WHERE user_id = $1)::bigint AS spins,
      (SELECT count(*) FROM balance_transactions WHERE user_id = $1)::bigint AS transactions,
      (SELECT data FROM app_documents WHERE document_key = 'casino_meta') AS casino
  `, [candidate.id])).rows[0];
  assert.deepStrictEqual(finalState, before, 'Sportsbook rollback verification changed persistent rehearsal data.');
  console.log(JSON.stringify({
    ok: true,
    slotTransactionRolledBack: true,
    puckIqLifecycleVerified: true,
    sportsbookPlaceUpdateCancelVerified: true,
    sportsbookSettlementAndVoidVerified: true,
    adminWalletAndAllowanceVerified: true,
    runtimeReadModelsVerified: true,
    oddsReadWriteVerified: true,
    maintenanceControlVerified: true,
    persistentStateUnchanged: true
  }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
