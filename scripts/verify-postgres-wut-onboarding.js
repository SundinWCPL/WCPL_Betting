import assert from 'node:assert/strict';
import { createPostgresPool, runPostgresMigrations } from '../database/postgres.js';
import { joinWutWithClient, openWutStarterPackWithClient } from '../database/repositories/wutOnboarding.js';

const pool = createPostgresPool({ applicationName: 'wcpl-wut-onboarding-verifier', max: 2 });
const client = await pool.connect();

async function snapshot(userId) {
  return (await pool.query(`
    SELECT
      (SELECT count(*) FROM wut_memberships WHERE user_id=$1)::bigint AS memberships,
      (SELECT count(*) FROM owned_cards WHERE user_id=$1)::bigint AS cards,
      (SELECT count(*) FROM owned_trinkets WHERE user_id=$1)::bigint AS trinkets,
      (SELECT count(*) FROM wut_decks WHERE user_id=$1)::bigint AS decks,
      (SELECT count(*) FROM pack_purchases WHERE user_id=$1)::bigint AS packs,
      (SELECT count(*) FROM wut_transactions WHERE user_id=$1)::bigint AS transactions
  `, [userId])).rows[0];
}

try {
  await runPostgresMigrations(pool);
  const candidate = (await pool.query(`
    SELECT u.id FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM wut_memberships m WHERE m.user_id=u.id)
    ORDER BY u.id LIMIT 1
  `)).rows[0];
  if (!candidate) throw new Error('Every rehearsal user has already joined WUT; no onboarding test candidate exists.');
  const before = await snapshot(candidate.id);
  await client.query('BEGIN');
  const joined = await joinWutWithClient(client, candidate.id, new Date('2026-07-06T14:00:00.000Z'));
  assert.equal(joined.joined, true);
  assert.equal(joined.starterOpened, false);
  const items = [
    { itemType: 'player', rolledTier: 'common', position: 'F', cardIdentity: 'START|F|1', divisionId: 'TEST', playerKey: 'f1', displayName: 'F1', edition: 'S3' },
    { itemType: 'player', rolledTier: 'common', position: 'F', cardIdentity: 'START|F|2', divisionId: 'TEST', playerKey: 'f2', displayName: 'F2', edition: 'S3' },
    { itemType: 'player', rolledTier: 'common', position: 'D', cardIdentity: 'START|D|1', divisionId: 'TEST', playerKey: 'd1', displayName: 'D1', edition: 'S3' },
    { itemType: 'player', rolledTier: 'common', position: 'D', cardIdentity: 'START|D|2', divisionId: 'TEST', playerKey: 'd2', displayName: 'D2', edition: 'S3' },
    { itemType: 'player', rolledTier: 'common', position: 'G', cardIdentity: 'START|G|1', divisionId: 'TEST', playerKey: 'g1', displayName: 'G1', edition: 'S3' }
  ];
  const bonusPackItems = [
    ...items.slice(0, 3),
    { itemType: 'boost', boostType: 'goal', rarity: 'common', effect: { goals: 1 } },
    { itemType: 'boost', boostType: 'grit', rarity: 'common', effect: { hits: 1, blocks: 1 } }
  ];
  const opened = await openWutStarterPackWithClient(client, {
    userId: candidate.id, items, bonusPackItems,
    now: new Date('2026-07-06T14:01:00.000Z'), random: () => 0.5
  });
  assert.equal(opened.cards.length, 5);
  assert.equal(new Set(opened.cards.map(card => card.card_identity)).size, 5);
  assert.equal(opened.trinkets.length, 2);
  assert.equal(opened.freePack.status, 'pending');
  assert.equal(opened.deck.active_card_ids.length, 5);
  assert.equal(opened.wutCoins, 1000);
  await assert.rejects(
    openWutStarterPackWithClient(client, { userId: candidate.id, items, bonusPackItems }),
    /already been opened/i
  );
  await client.query('ROLLBACK');
  assert.deepStrictEqual(await snapshot(candidate.id), before, 'WUT onboarding rollback changed persistent rehearsal data.');
  console.log(JSON.stringify({
    ok: true,
    joinVerified: true,
    starterFiveCardsVerified: true,
    starterTrinketsVerified: true,
    freePackVerified: true,
    starterCoinsAndDeckVerified: true,
    duplicateOpenBlocked: true,
    persistentStateUnchanged: true
  }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
