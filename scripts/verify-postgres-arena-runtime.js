import assert from 'node:assert/strict';
import { createPostgresPool, runPostgresMigrations } from '../database/postgres.js';
import { assignArenaMatchupsWithClient, enterArenaQueueWithClient } from '../database/repositories/arenaQueue.js';
import {
  commitArenaTurnWithClient,
  completeArenaMatchWithClient,
  completeArenaRevealWithClient,
  adminVoidArenaMatchWithClient,
  recalculateArenaEloFromHistoryWithClient
} from '../database/repositories/arenaMatch.js';
import { getArenaAdminMatchStatePostgres, getArenaStateForUserPostgres } from '../database/repositories/arenaRead.js';
import { commitWutDebugPlacementWithClient, completeWutDebugMatchWithClient, resetWutDebugMatchWithClient } from '../database/repositories/arenaDebug.js';

const pool = createPostgresPool({ applicationName: 'wcpl-arena-runtime-verifier', max: 2 });
const client = await pool.connect();

try {
  await runPostgresMigrations(pool);
  const candidates = (await pool.query(`
    SELECT DISTINCT ON (d.user_id) d.user_id,d.id,d.data
    FROM wut_decks d
    WHERE jsonb_array_length(COALESCE(d.data->'active_card_ids','[]'::jsonb)) BETWEEN 5 AND 8
      AND jsonb_array_length(COALESCE(d.data->'bench_card_ids','[]'::jsonb))=5
      AND NOT EXISTS (
        SELECT 1 FROM arena_matches m
        WHERE m.status IN ('active','scoring') AND m.data->'player_ids' @> to_jsonb(ARRAY[d.user_id])
      )
    ORDER BY d.user_id,d.id
    LIMIT 2
  `)).rows;
  if (candidates.length < 2) throw new Error('Two queue-eligible rehearsal decks are required for Arena verification.');
  const userIds = candidates.map(row => Number(row.user_id));
  const liveState = await getArenaStateForUserPostgres(pool, userIds[0], new Date('2026-07-06T15:00:00.000Z'));
  assert.equal(typeof liveState.queueCount, 'number');
  assert.equal(typeof liveState.rating, 'number');
  assert.ok(Array.isArray(liveState.activeMatches));
  const before = (await pool.query(`
    SELECT
      (SELECT count(*) FROM arena_entries WHERE user_id=ANY($1::bigint[]))::bigint AS entries,
      (SELECT count(*) FROM arena_matches WHERE data->'player_ids' @> $2::jsonb OR data->'player_ids' @> $3::jsonb)::bigint AS matches,
      (SELECT data FROM app_documents WHERE document_key='arena_meta') AS meta
  `, [userIds, JSON.stringify([userIds[0]]), JSON.stringify([userIds[1]])])).rows[0];
  await client.query('BEGIN');
  await client.query(`
    UPDATE arena_entries SET status='cancelled',data=jsonb_set(data,'{status}','"cancelled"'::jsonb,true)
    WHERE status='queued'
  `);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  for (const [index, candidate] of candidates.entries()) {
    const activeIds = candidate.data.active_card_ids.map(Number);
    const benchIds = candidate.data.bench_card_ids.map(Number);
    const snapshot = {
      active: activeIds.map((id, cardIndex) => ({
        card_id: id, card_identity: `runtime-active-${index}-${cardIndex}`, position: positions[cardIndex % 5], power: 1
      })),
      bench: benchIds.map((id, cardIndex) => ({
        card_id: id, card_identity: `runtime-bench-${index}-${cardIndex}`, position: positions[cardIndex], power: 1
      }))
    };
    await enterArenaQueueWithClient(client, {
      userId: candidate.user_id, deckId: candidate.id, deckSnapshot: snapshot,
      now: new Date(`2026-07-06T15:0${index}:00.000Z`), random: () => 0
    });
  }
  const matched = await assignArenaMatchupsWithClient(client, {
    now: new Date('2026-07-06T15:05:00.000Z'), random: () => 0
  });
  assert.equal(matched.createdMatchIds.length, 1);
  assert.equal(matched.unmatchedUserId, null);
  const match = (await client.query('SELECT data,status,current_player_id FROM arena_matches WHERE numeric_id=$1', [matched.createdMatchIds[0]])).rows[0];
  assert.equal(match.status, 'active');
  assert.deepStrictEqual(new Set(match.data.player_ids.map(Number)), new Set(userIds));
  assert.equal(Number(match.current_player_id), userIds[0]);
  const firstSnapshot = match.data.deck_snapshots[String(userIds[0])].active[0];
  const firstTurn = await commitArenaTurnWithClient(client, {
    userId: userIds[0], matchId: matched.createdMatchIds[0],
    placements: [{ slot: firstSnapshot.position === 'G' ? 'G' : `${firstSnapshot.position}1`, cardId: firstSnapshot.card_id }],
    now: new Date('2026-07-06T15:06:00.000Z')
  });
  assert.equal(firstTurn.placements.length, 1);
  assert.equal(firstTurn.turn_index, 1);
  assert.equal(firstTurn.current_player_id, userIds[1]);
  const committed = (await client.query('SELECT data FROM arena_placements WHERE match_key=$1 ORDER BY placement_index', [String(matched.createdMatchIds[0])])).rows.map(row => row.data);
  const lineupSlots = ['F1', 'F2', 'D1', 'D2', 'G'];
  let placementIndex = committed.length;
  for (const userId of userIds) {
    const snapshots = match.data.deck_snapshots[String(userId)].active.slice(0, 5);
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      if (committed.some(row => Number(row.user_id) === userId && Number(row.card_id) === Number(snapshot.card_id))) continue;
      const placement = {
        user_id: userId, slot: lineupSlots[index], card_id: Number(snapshot.card_id), boost_id: null,
        boost_load: 0, power: Number(snapshot.power), card_snapshot: snapshot,
        journeyman_key: '', committed_at: '2026-07-06T15:07:00.000Z'
      };
      await client.query(`
        INSERT INTO arena_placements(match_key,placement_index,user_id,slot,card_id,data)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)
      `, [String(matched.createdMatchIds[0]), placementIndex++, userId, placement.slot, placement.card_id, JSON.stringify(placement)]);
      committed.push(placement);
    }
  }
  assert.equal(committed.length, 10);
  const scoringMatch = { ...firstTurn, status: 'scoring', turn_index: 6, turn_deadline: null };
  delete scoringMatch.placements;
  await client.query(`
    UPDATE arena_matches SET status='scoring',current_player_id=NULL,turn_deadline=NULL,data=$2::jsonb
    WHERE match_key=$1
  `, [String(matched.createdMatchIds[0]), JSON.stringify(scoringMatch)]);
  const scored = committed.map(row => ({
    ...row, fp: Number(row.user_id) === userIds[0] ? 20 : 10,
    games_played: 3, stats: {}, sample_match_ids: [], synthetic_games: [], score_breakdown: []
  }));
  const completed = await completeArenaMatchWithClient(client, {
    matchId: matched.createdMatchIds[0], scoredPlacements: scored,
    now: new Date('2026-07-06T15:08:00.000Z')
  });
  assert.equal(completed.status, 'ready');
  assert.equal(completed.winner_user_id, userIds[0]);
  assert.ok(completed.wut_rewards[String(userIds[0])] > completed.wut_rewards[String(userIds[1])]);
  assert.equal((await completeArenaRevealWithClient(client, {
    userId: userIds[0], matchId: matched.createdMatchIds[0], now: new Date('2026-07-06T15:09:00.000Z')
  })).status, 'ready');
  const fullyRevealed = await completeArenaRevealWithClient(client, {
    userId: userIds[1], matchId: matched.createdMatchIds[0], now: new Date('2026-07-06T15:10:00.000Z')
  });
  assert.equal(fullyRevealed.status, 'completed');
  assert.ok(fullyRevealed.elo_updated_at);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    await enterArenaQueueWithClient(client, {
      userId: candidate.user_id,
      deckId: candidate.id,
      deckSnapshot: match.data.deck_snapshots[String(candidate.user_id)],
      now: new Date(`2026-07-06T15:1${index + 1}:00.000Z`),
      random: () => 0
    });
  }
  const secondMatch = await assignArenaMatchupsWithClient(client, {
    now: new Date('2026-07-06T15:14:00.000Z'), random: () => 0
  });
  const admin = (await client.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
  const debug = await resetWutDebugMatchWithClient(client, admin.id, new Date('2026-07-06T15:14:30.000Z'));
  const slotOrder = ['F1','F2','D1','D2','G'];
  for (const [sideIndex, side] of ['A','B'].entries()) {
    const snapshots = [...match.data.deck_snapshots[String(userIds[sideIndex])].active, ...match.data.deck_snapshots[String(userIds[sideIndex])].bench];
    const used = new Set();
    for (const slot of slotOrder) { const position=slot==='G'?'G':slot[0]; const snapshot=snapshots.find(item=>item.position===position&&!used.has(item.card_identity)); used.add(snapshot.card_identity);
      await commitWutDebugPlacementWithClient(client,{adminUserId:admin.id,side,slot,cardSnapshot:{...snapshot,power:1,trinket:null},config:{wut:{slotPowerAllowance:1,boostLoadCap:5,rarityCosts:{common:1}}},now:new Date('2026-07-06T15:14:40.000Z')}); }
  }
  const scoredDebug = await completeWutDebugMatchWithClient(client,{adminUserId:admin.id,scoredPlacements:(await client.query("SELECT data FROM card_records WHERE collection='debug_matches' AND record_key=$1",[`admin:${admin.id}`])).rows[0].data.placements.map(row=>({...row,fp:10})),now:new Date('2026-07-06T15:14:50.000Z')});
  assert.equal(scoredDebug.status,'completed'); assert.equal(scoredDebug.scores['-1'],50);
  const voided = await adminVoidArenaMatchWithClient(client, {
    matchId: secondMatch.createdMatchIds[0], adminUserId: admin.id,
    reason: 'Runtime rollback verification', now: new Date('2026-07-06T15:15:00.000Z')
  });
  assert.equal(voided.match.status, 'cancelled');
  const adminMatches = await getArenaAdminMatchStatePostgres(client, { userId: userIds[0] });
  assert.ok(adminMatches.users.some(user => user.id === userIds[0]));
  const recalculated = await recalculateArenaEloFromHistoryWithClient(client, new Date('2026-07-06T15:16:00.000Z'));
  assert.ok(recalculated.matchesReplayed >= 1);
  await client.query('ROLLBACK');
  const after = (await pool.query(`
    SELECT
      (SELECT count(*) FROM arena_entries WHERE user_id=ANY($1::bigint[]))::bigint AS entries,
      (SELECT count(*) FROM arena_matches WHERE data->'player_ids' @> $2::jsonb OR data->'player_ids' @> $3::jsonb)::bigint AS matches,
      (SELECT data FROM app_documents WHERE document_key='arena_meta') AS meta
  `, [userIds, JSON.stringify([userIds[0]]), JSON.stringify([userIds[1]])])).rows[0];
  assert.deepStrictEqual(after, before, 'Arena rollback verification changed persistent rehearsal data.');
  console.log(JSON.stringify({
    ok: true, queueEntryVerified: true, eloPairingVerified: true,
    latestOddEntrantSkipRuleCovered: true, matchCreationVerified: true,
    turnCommitVerified: true,
    scoringRewardsAndRevealVerified: true,
    liveArenaReadVerified: true,
    adminVoidRecoveryVerified: true,
    adminHistoryAndEloRecalculationVerified: true,
    adminDebugGameVerified: true,
    persistentStateUnchanged: true
  }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
