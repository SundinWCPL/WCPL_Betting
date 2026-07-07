import assert from 'node:assert/strict';
import { createPostgresPool, runPostgresMigrations } from '../database/postgres.js';
import { NIGHTLY_WUT_DRAFT_PRESET } from '../services/wutDraftEvents.js';
import { adjustWutCoinBalanceWithClient } from '../database/repositories/wutAdmin.js';
import {
  createWutDraftEventWithClient,
  pauseWutDraftEventWithClient,
  rescheduleWutDraftEventWithClient,
  resumeWutDraftEventWithClient,
  saveWutDraftEventPresetWithClient,
  joinWutDraftEventWithClient,
  transitionWutDraftEventWithClient,
  withdrawWutDraftEventWithClient
} from '../database/repositories/draftEvents.js';
import { getDraftEventPostgres, lockAndLoadDraftEvent } from '../database/repositories/draftEventStore.js';
import {
  beginWutDraftEventWithClient,
  extendWutDraftPickDeadlineWithClient,
  pickWutDraftItemWithClient,
  startWutDraftEventWithClient
} from '../database/repositories/draftGameplay.js';
import {
  attachWutDraftEventTrinketWithClient,
  detachWutDraftEventTrinketWithClient,
  saveWutDraftEventDeckWithClient
} from '../database/repositories/draftDecks.js';
import {
  beginWutDraftSafetyBenchWithClient,
  finishWutDraftSafetyBenchWithClient,
  voteWutDraftSafetyBenchWithClient
} from '../database/repositories/draftBench.js';
import {
  commitWutDraftEventTurnWithClient,
  completeWutDraftEventMatchWithClient,
  completeWutDraftEventRevealWithClient,
  awardWutDraftEventPrizesWithClient,
  resetCurrentWutDraftEventRoundWithClient
} from '../database/repositories/draftTournament.js';

const pool = createPostgresPool({ applicationName: 'wcpl-draft-runtime-verifier', max: 2 });
const client = await pool.connect();

try {
  await runPostgresMigrations(pool);
  const admin = (await pool.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
  const entrant = (await pool.query(`
    SELECT user_id,wut_coins FROM wut_memberships
    WHERE data->>'starter_opened_at' IS NOT NULL ORDER BY user_id LIMIT 1
  `)).rows[0];
  if (!admin || !entrant) throw new Error('Draft verifier needs an admin and a WUT member.');
  const existingEvent = (await pool.query('SELECT id FROM draft_events ORDER BY id LIMIT 1')).rows[0];
  if (existingEvent) assert.equal((await getDraftEventPostgres(pool, existingEvent.id)).id, Number(existingEvent.id));
  const before = (await pool.query(`
    SELECT
      (SELECT count(*) FROM draft_events)::bigint AS events,
      (SELECT wut_coins FROM wut_memberships WHERE user_id=$1)::bigint AS coins,
      (SELECT count(*) FROM wut_transactions WHERE user_id=$1)::bigint AS transactions
  `, [entrant.user_id])).rows[0];
  await client.query('BEGIN');
  await adjustWutCoinBalanceWithClient(client, {
    userId: entrant.user_id, amount: 1000, note: 'Draft runtime verification', adminUserId: admin.id
  });
  const config = JSON.parse(JSON.stringify(NIGHTLY_WUT_DRAFT_PRESET.config));
  config.basic.name = 'Runtime Rollback Draft';
  config.basic.entryFee = { currency: 'wut_coin', amount: 100 };
  config.basic.minimumEntrants = 2;
  config.basic.maximumEntrants = 4;
  config.scheduling = { signupOpensAt: null, signupClosesAt: null, startsAt: null, recurring: null };
  const event = await createWutDraftEventWithClient(client, {
    config, adminUserId: admin.id, now: new Date('2026-07-06T16:00:00.000Z')
  });
  const preset = await saveWutDraftEventPresetWithClient(client, { name: 'Runtime rollback preset', config, adminUserId: admin.id });
  assert.equal(preset.config.basic.name, config.basic.name);
  await rescheduleWutDraftEventWithClient(client, { eventId: event.id, adminUserId: admin.id, startsAt: '2026-07-06T12:00' });
  await pauseWutDraftEventWithClient(client, { eventId: event.id, adminUserId: admin.id, reason: 'Verifier pause' });
  await resumeWutDraftEventWithClient(client, { eventId: event.id, adminUserId: admin.id });
  await transitionWutDraftEventWithClient(client, {
    eventId: event.id, nextPhase: 'signup_open', adminUserId: admin.id,
    now: new Date('2026-07-06T16:01:00.000Z')
  });
  const joined = await joinWutDraftEventWithClient(client, {
    eventId: event.id, userId: entrant.user_id, now: new Date('2026-07-06T16:02:00.000Z')
  });
  assert.equal(joined.entrants.filter(row => row.status === 'active').length, 1);
  const withdrawn = await withdrawWutDraftEventWithClient(client, {
    eventId: event.id, userId: entrant.user_id, now: new Date('2026-07-06T16:03:00.000Z')
  });
  assert.equal(withdrawn.entrants.at(-1).status, 'withdrawn');
  assert.ok(withdrawn.entrants.at(-1).refunded_at);
  await joinWutDraftEventWithClient(client, {
    eventId: event.id, userId: entrant.user_id, now: new Date('2026-07-06T16:04:00.000Z')
  });
  const cancelled = await transitionWutDraftEventWithClient(client, {
    eventId: event.id, nextPhase: 'cancelled', adminUserId: admin.id,
    reason: 'Runtime verification', now: new Date('2026-07-06T16:05:00.000Z')
  });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.entrants.filter(row => row.refunded_at).length, 2);
  const loaded = await lockAndLoadDraftEvent(client, event.id);
  assert.equal(loaded.phase, 'cancelled');
  assert.equal(loaded.logs.length, cancelled.logs.length);
  assert.equal(loaded.entrants.length, 2);
  const secondEntrant = (await client.query(`
    SELECT user_id FROM wut_memberships
    WHERE data->>'starter_opened_at' IS NOT NULL AND user_id<>$1
    ORDER BY user_id LIMIT 1
  `, [entrant.user_id])).rows[0];
  if (!secondEntrant) throw new Error('Draft gameplay verifier needs a second WUT member.');
  const gameplayConfig = JSON.parse(JSON.stringify(NIGHTLY_WUT_DRAFT_PRESET.config));
  gameplayConfig.basic.name = 'Runtime Booster Draft';
  gameplayConfig.basic.entryFee = { currency: 'free', amount: 0 };
  gameplayConfig.basic.minimumEntrants = 2;
  gameplayConfig.basic.maximumEntrants = 2;
  gameplayConfig.safetyBench.mode = 'shared_vote';
  gameplayConfig.deckbuilding.activeMinimum = 1;
  gameplayConfig.deckbuilding.activeMaximum = 2;
  gameplayConfig.tournament.format = 'single_elimination';
  gameplayConfig.match.simultaneousMatches = true;
  gameplayConfig.boosters.countPerPlayer = 1;
  gameplayConfig.boosters.contents = { players: 2, boosts: 1, trinkets: 1 };
  for (const kind of ['players', 'boosts', 'trinkets']) {
    gameplayConfig.boosters.rarityOdds[kind] = { common: 100, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
    gameplayConfig.boosters.rarityLimits[kind] = { minimum: 'common', maximum: 'common' };
  }
  const gameplayEvent = await createWutDraftEventWithClient(client, {
    config: gameplayConfig, adminUserId: admin.id, now: new Date('2026-07-06T16:10:00.000Z')
  });
  await transitionWutDraftEventWithClient(client, {
    eventId: gameplayEvent.id, nextPhase: 'signup_open', adminUserId: admin.id,
    now: new Date('2026-07-06T16:11:00.000Z')
  });
  for (const [index, userId] of [entrant.user_id, secondEntrant.user_id].entries()) {
    await joinWutDraftEventWithClient(client, {
      eventId: gameplayEvent.id, userId, now: new Date(`2026-07-06T16:1${index + 2}:00.000Z`)
    });
  }
  await transitionWutDraftEventWithClient(client, {
    eventId: gameplayEvent.id, nextPhase: 'signup_closed', adminUserId: admin.id,
    now: new Date('2026-07-06T16:14:00.000Z')
  });
  const cards = Array.from({ length: 12 }, (_, index) => ({
    cardIdentity: `DRAFT|COMMON|${index}`, catalogKey: `DRAFT|COMMON|${index}`,
    cardType: 'player', edition: 'S2', sourceSeason: 'S2', divisionId: 'TEST',
    playerKey: `player-${index}`, displayName: `Player ${index}`, position: ['F', 'D', 'G'][index % 3],
    tier: 'common', sourceTeamId: `T${index % 4}`, teamId: `T${index % 4}`
  }));
  const environment = {
    cards,
    rules: {
      rarityCosts: { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 },
      boostEffects: { goal: { common: { goals: 1 } } },
      trinketEffects: { safety_net: { common: 0.25 } }
    }
  };
  await startWutDraftEventWithClient(client, {
    eventId: gameplayEvent.id, environment, adminUserId: admin.id,
    now: new Date('2026-07-06T16:15:00.000Z')
  });
  const bench = await beginWutDraftSafetyBenchWithClient(client, {
    eventId: gameplayEvent.id, adminUserId: admin.id,
    now: new Date('2026-07-06T16:16:00.000Z'), random: () => 0.25
  });
  assert.equal(bench.phase, 'bench_vote');
  const selections = Object.fromEntries(['F', 'D', 'G'].map(position => [position,
    bench.bench.candidates.filter(candidate => candidate.position === position)
      .slice(0, gameplayConfig.safetyBench.positions[position].winners).map(candidate => candidate.card.cardIdentity)
  ]));
  for (const userId of [entrant.user_id, secondEntrant.user_id]) await voteWutDraftSafetyBenchWithClient(client, {
    eventId: gameplayEvent.id, userId, selections, now: new Date('2026-07-06T16:16:30.000Z')
  });
  const begun = await finishWutDraftSafetyBenchWithClient(client, {
    eventId: gameplayEvent.id, adminUserId: admin.id, now: new Date('2026-07-06T16:16:45.000Z'), random: () => 0.25
  });
  assert.equal(begun.phase, 'draft');
  assert.equal(begun.draft.boosters.length, 2);
  const extendedDraft = await extendWutDraftPickDeadlineWithClient(client, { eventId: gameplayEvent.id, adminUserId: admin.id, seconds: 30 });
  assert.ok(new Date(extendedDraft.draft.deadline_at) > new Date(begun.draft.deadline_at));
  const compositions = begun.draft.boosters.map(pack => pack.items.map(item => `${item.item_type}:${item.rarity}`));
  assert.deepStrictEqual(compositions[0], compositions[1]);
  for (const [index, userId] of begun.draft.pending_user_ids.entries()) {
    const current = index === 0 ? begun : await lockAndLoadDraftEvent(client, gameplayEvent.id);
    const pack = current.draft.boosters.find(item => Number(item.current_owner_user_id) === Number(userId) && !item.awaiting_pass);
    await pickWutDraftItemWithClient(client, {
      eventId: gameplayEvent.id, userId, itemId: pack.items[0].id,
      now: new Date(`2026-07-06T16:1${index + 7}:00.000Z`)
    });
  }
  const afterPicks = await lockAndLoadDraftEvent(client, gameplayEvent.id);
  assert.equal(afterPicks.draft.picks.length, 2);
  assert.equal(Object.values(afterPicks.inventories).reduce((sum, inventory) =>
    sum + inventory.cards.length + inventory.boosts.length + inventory.trinkets.length, 0), 12);
  let pickTime = new Date('2026-07-06T16:20:00.000Z');
  while (true) {
    const current = await lockAndLoadDraftEvent(client, gameplayEvent.id);
    if (current.phase !== 'draft') break;
    for (const userId of [...current.draft.pending_user_ids]) {
      const latest = await lockAndLoadDraftEvent(client, gameplayEvent.id);
      const inventory = latest.inventories[String(userId)];
      const pack = latest.draft.boosters.find(item =>
        Number(item.booster_number) === Number(latest.draft.current_booster) &&
        Number(item.current_owner_user_id) === Number(userId) && !item.awaiting_pass && item.items.length
      );
      const wantedType = !inventory.trinkets.length ? 'trinket' : !inventory.cards.length ? 'player' : null;
      const item = pack.items.find(candidate => candidate.item_type === wantedType) || pack.items[0];
      await pickWutDraftItemWithClient(client, { eventId: gameplayEvent.id, userId, itemId: item.id, now: pickTime });
      pickTime = new Date(pickTime.getTime() + 1000);
    }
  }
  const drafted = await lockAndLoadDraftEvent(client, gameplayEvent.id);
  assert.equal(drafted.phase, 'deckbuilding');
  assert.equal(drafted.draft.picks.length, 8);
  const firstInventory = drafted.inventories[String(entrant.user_id)];
  assert.ok(firstInventory.cards.length >= 1);
  assert.ok(firstInventory.trinkets.length >= 1);
  assert.equal(firstInventory.safety_bench_card_ids.length, 5);
  const card = firstInventory.cards.find(item => !firstInventory.safety_bench_card_ids.map(Number).includes(Number(item.id)));
  const trinket = firstInventory.trinkets[0];
  const attached = await attachWutDraftEventTrinketWithClient(client, {
    eventId: gameplayEvent.id, userId: entrant.user_id, cardId: card.id, trinketId: trinket.id,
    now: new Date('2026-07-06T16:21:00.000Z')
  });
  assert.equal(attached.inventories[String(entrant.user_id)].cards.find(item => Number(item.id) === Number(card.id)).trinket_id, trinket.id);
  const storedDeck = await saveWutDraftEventDeckWithClient(client, {
    eventId: gameplayEvent.id, userId: entrant.user_id, activeCardIds: [card.id],
    now: new Date('2026-07-06T16:22:00.000Z')
  });
  assert.equal(storedDeck.deck.active_snapshots[0].trinket.id, trinket.id);
  const detached = await detachWutDraftEventTrinketWithClient(client, {
    eventId: gameplayEvent.id, userId: entrant.user_id, cardId: card.id,
    now: new Date('2026-07-06T16:23:00.000Z')
  });
  assert.equal(detached.decks[String(entrant.user_id)].active_snapshots[0].trinket, null);
  const secondInventory = detached.inventories[String(secondEntrant.user_id)];
  const secondCard = secondInventory.cards.find(item => !secondInventory.safety_bench_card_ids.map(Number).includes(Number(item.id)));
  const tournamentStart = await saveWutDraftEventDeckWithClient(client, {
    eventId: gameplayEvent.id, userId: secondEntrant.user_id, activeCardIds: [secondCard.id],
    now: new Date('2026-07-06T16:24:00.000Z')
  });
  assert.equal(tournamentStart.event.phase, 'tournament');
  const resetRound = await resetCurrentWutDraftEventRoundWithClient(client, { eventId: gameplayEvent.id, adminUserId: admin.id, reason: 'Verifier reset' });
  let tournamentMatch = resetRound.tournament.matches[0];
  assert.equal(tournamentMatch.status, 'active');
  while (tournamentMatch.status === 'active') {
    const first = Number(tournamentMatch.first_player_id);
    const other = Number(tournamentMatch.player_ids.find(id => Number(id) !== first));
    const currentUserId = Number(tournamentMatch.turn_index) % 2 === 0 ? first : other;
    const required = [1, 2, 2, 2, 2, 1][Number(tournamentMatch.turn_index)];
    const existing = tournamentMatch.placements.filter(row => Number(row.user_id) === currentUserId);
    const occupied = new Set(existing.map(row => row.slot));
    const used = new Set(existing.map(row => Number(row.card_id)));
    const deckCards = [...tournamentMatch.deck_snapshots[String(currentUserId)].active, ...tournamentMatch.deck_snapshots[String(currentUserId)].bench];
    const turn = [];
    for (const slot of ['F1', 'F2', 'D1', 'D2', 'G']) {
      if (occupied.has(slot) || turn.length >= required) continue;
      const position = slot === 'G' ? 'G' : slot[0];
      const snapshot = deckCards.find(card => card.position === position && !used.has(Number(card.card_id)) && !turn.some(row => Number(row.cardId) === Number(card.card_id)));
      if (snapshot) turn.push({ slot, cardId: snapshot.card_id });
    }
    assert.equal(turn.length, required);
    tournamentMatch = await commitWutDraftEventTurnWithClient(client, {
      eventId: gameplayEvent.id, matchId: tournamentMatch.id, userId: currentUserId, placements: turn,
      now: new Date('2026-07-06T16:25:00.000Z')
    });
  }
  assert.equal(tournamentMatch.status, 'scoring');
  const scored = tournamentMatch.placements.map(row => ({ ...row, fp: Number(row.user_id) === Number(entrant.user_id) ? 20 : 10,
    games_played: 3, stats: {}, sample_match_ids: [], synthetic_games: [], score_breakdown: [] }));
  tournamentMatch = await completeWutDraftEventMatchWithClient(client, {
    eventId: gameplayEvent.id, matchId: tournamentMatch.id, scoredPlacements: scored,
    now: new Date('2026-07-06T16:26:00.000Z')
  });
  assert.equal(tournamentMatch.status, 'ready');
  await completeWutDraftEventRevealWithClient(client, { eventId: gameplayEvent.id, matchId: tournamentMatch.id,
    userId: entrant.user_id, now: new Date('2026-07-06T16:27:00.000Z') });
  await completeWutDraftEventRevealWithClient(client, { eventId: gameplayEvent.id, matchId: tournamentMatch.id,
    userId: secondEntrant.user_id, now: new Date('2026-07-06T16:28:00.000Z') });
  assert.equal((await lockAndLoadDraftEvent(client, gameplayEvent.id)).phase, 'complete');
  const prizeItems = [
    { itemType:'player',cardIdentity:'PRIZE|F',divisionId:'TEST',playerKey:'pf',displayName:'Prize F',edition:'S3' },
    { itemType:'player',cardIdentity:'PRIZE|D',divisionId:'TEST',playerKey:'pd',displayName:'Prize D',edition:'S3' },
    { itemType:'player',cardIdentity:'PRIZE|G',divisionId:'TEST',playerKey:'pg',displayName:'Prize G',edition:'S3' },
    { itemType:'boost',boostType:'goal',rarity:'common',effect:{ per:1,bonus:1 } },
    { itemType:'boost',boostType:'grit',rarity:'common',effect:{ per:1,bonus:1 } }
  ];
  const prizes = await awardWutDraftEventPrizesWithClient(client, { eventId: gameplayEvent.id, adminUserId: admin.id, generatePack: () => prizeItems, random: () => 0.1, now: new Date('2026-07-06T16:29:00.000Z') });
  assert.equal(prizes.event.phase, 'prizes_awarded');
  const insideCoins = await client.query('SELECT wut_coins FROM wut_memberships WHERE user_id=$1', [entrant.user_id]);
  assert.equal(Number(insideCoins.rows[0].wut_coins), Number(entrant.wut_coins) + 1000);
  await client.query('ROLLBACK');
  const after = (await pool.query(`
    SELECT
      (SELECT count(*) FROM draft_events)::bigint AS events,
      (SELECT wut_coins FROM wut_memberships WHERE user_id=$1)::bigint AS coins,
      (SELECT count(*) FROM wut_transactions WHERE user_id=$1)::bigint AS transactions
  `, [entrant.user_id])).rows[0];
  assert.deepStrictEqual(after, before, 'Draft rollback verification changed persistent rehearsal data.');
  console.log(JSON.stringify({
    ok: true, eventCreationVerified: true, perEventRoundTripVerified: true,
    signupChargeAndWithdrawalRefundVerified: true, cancellationRefundVerified: true,
    entrantHistoryPreserved: true, identicalBoosterCompositionVerified: true,
    visualPickPersistenceVerified: true, eventDeckPersistenceVerified: true,
    temporaryTrinketAttachmentVerified: true, liveEventReadVerified: true,
    sharedSafetyBenchVerified: true,
    tournamentLifecycleVerified: true,
    adminRecoveryAndPrizeAwardVerified: true,
    persistentStateUnchanged: true
  }, null, 2));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
