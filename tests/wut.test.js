import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import qs from 'qs';

const dbPath = path.join(os.tmpdir(), `wcpl-wut-${process.pid}.json`);
const backupPath = path.join(os.tmpdir(), `wcpl-wut-backups-${process.pid}`);
process.env.JSON_DB_PATH = dbPath;
process.env.BACKUP_DIR = backupPath;
const db = await import('../db.js');
const cards = await import('../services/cards.js');
const draftEvents = await import('../services/wutDraftEvents.js');
const arenaRuntime = await import('../services/arenaRuntime.js');

test.after(() => { try { fs.unlinkSync(dbPath); } catch {} try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch {} });

test('Power uses card rarity plus the reduced trinket scale, never boosts', () => {
  assert.equal(db.calculateWutPower('common'), 1);
  assert.equal(db.calculateWutPower('common', 'common'), 1);
  assert.equal(db.calculateWutPower('common', 'uncommon'), 1.5);
  assert.equal(db.calculateWutPower('common', 'rare'), 2);
  assert.equal(db.calculateWutPower('common', 'epic'), 2.5);
  assert.equal(db.calculateWutPower('common', 'legendary'), 3.5);
  assert.equal(db.calculateWutPower('legendary', 'legendary'), 7.5);
  assert.equal(db.calculateWutPower('mythic'), 6);
});

test('Draft Event wall times are always interpreted in Pacific Time', () => {
  assert.equal(draftEvents.wutPacificDateTimeToIso('2026-07-04T19:00'), '2026-07-05T02:00:00.000Z', 'summer uses PDT');
  assert.equal(draftEvents.wutPacificDateTimeToIso('2026-01-04T19:00'), '2026-01-05T03:00:00.000Z', 'winter uses PST');
  assert.equal(draftEvents.wutPacificDateTimeToIso('2026-07-05T02:00:00.000Z'), '2026-07-05T02:00:00.000Z', 'absolute timestamps remain unchanged');
  assert.throws(() => draftEvents.wutPacificDateTimeToIso('2026-03-08T02:30'), /does not exist in Pacific Time/);
});

test('the public Draft lobby keeps completed events visible until prize packs are claimed', () => {
  for (const phase of ['scheduled', 'signup_open', 'signup_closed', 'starting', 'bench_vote', 'draft', 'deckbuilding', 'tournament']) {
    assert.equal(draftEvents.isWutDraftEventLobbyVisible({ phase }), true, `${phase} should remain visible`);
  }
  assert.equal(draftEvents.isWutDraftEventLobbyVisible({ phase: 'complete' }), true, 'complete events should remain visible for prize follow-up');
  assert.equal(draftEvents.isWutDraftEventLobbyVisible({ phase: 'prizes_awarded', prizes: { awards: [{ type: 'player_pack', status: 'pending' }] } }), true, 'events with pending prize packs should remain visible');
  assert.equal(draftEvents.isWutDraftEventLobbyVisible({ phase: 'prizes_awarded', prizes: { awards: [{ type: 'player_pack', status: 'queued' }] } }), true, 'events with queued prize packs should remain visible');
  for (const phase of ['prizes_awarded', 'cancelled']) {
    assert.equal(draftEvents.isWutDraftEventLobbyVisible({ phase }), false, `${phase} should be hidden`);
  }
  assert.equal(draftEvents.isWutDraftEventLobbyVisible({ phase: 'prizes_awarded', prizes: { awards: [{ type: 'player_pack', status: 'claimed' }] } }), false, 'claimed prize packs can leave the lobby');
});

test('Draft Event prizes cannot be bypassed with a plain phase transition', () => {
  const event = { phase: 'complete', paused_at: null, deadlines: {}, logs: [], nextLogId: 1 };
  assert.throws(() => draftEvents.transitionWutDraftEventRecord(event, 'prizes_awarded'), /prize award action/);
  draftEvents.transitionWutDraftEventRecord(event, 'prizes_awarded', { allowPrizeAwardTransition: true });
  assert.equal(event.phase, 'prizes_awarded');
});

test('single-elimination byes reward FP performance and avoid repeat recipients', () => {
  const seeded = [1, 2, 3, 4, 5, 6, 7];
  const equalGames = seeded.map(userId => ({ user_id: userId, played: 1, fp_for: userId === 4 ? 120 : 50 + userId }));
  assert.equal(draftEvents.selectWutDraftEliminationBye(seeded, equalGames), 4, 'highest total FP earns the bye when match counts are equal');
  assert.equal(draftEvents.selectWutDraftEliminationBye(seeded, equalGames, [4]), 7, 'a prior bye recipient yields to the best eligible alternative');
  const unequalGames = [
    { user_id: 1, played: 1, fp_for: 100 },
    { user_id: 2, played: 2, fp_for: 150 },
    ...seeded.slice(2).map(userId => ({ user_id: userId, played: 2, fp_for: 40 }))
  ];
  assert.equal(draftEvents.selectWutDraftEliminationBye(seeded, unequalGames), 1, 'FP per match controls when candidates have played different totals');
  assert.equal(draftEvents.selectWutDraftEliminationBye([7, 6, 5], [], []), 7, 'original seed breaks a scoreless exact tie');
});

test('Railway startup refuses missing or suspiciously reset production databases', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wcpl-railway-guard-'));
  const database = path.join(directory, 'betting.json');
  const moduleUrl = pathToFileURL(path.resolve('db.js')).href;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '--eval', `import(${JSON.stringify(moduleUrl)}).then(db => db.initDb())`], {
    cwd: path.resolve('.'), encoding: 'utf8',
    env: {
      ...process.env,
      JSON_DB_PATH: database,
      BACKUP_DIR: path.join(directory, 'backups'),
      RAILWAY_PROJECT_ID: 'production-guard-test',
      RAILWAY_VOLUME_MOUNT_PATH: directory
    }
  });

  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /Refusing to initialize an empty production database/);
  assert.equal(fs.existsSync(database), false, 'a missing production database must never be seeded');

  const suspicious = JSON.stringify({ settings: { currentWeek: 1 }, users: [{ id: 1, username: 'Sundin' }], nextUserId: 2 });
  fs.writeFileSync(database, suspicious);
  const reset = run();
  assert.notEqual(reset.status, 0);
  assert.match(`${reset.stdout}${reset.stderr}`, /suspiciously empty production database/);
  assert.equal(fs.readFileSync(database, 'utf8'), suspicious, 'the suspicious file must remain untouched');

  const valid = JSON.stringify({
    settings: { currentWeek: 1, lockedWeeks: [], bettingLocked: false },
    users: [
      { id: 1, username: 'Sundin', display_name: 'Sundin', role: 'admin', password_hash: 'preserved', balance: 0 },
      { id: 2, username: 'keeper', display_name: 'Keeper', role: 'user', password_hash: 'preserved', balance: 500 }
    ],
    nextUserId: 3
  });
  fs.writeFileSync(database, valid);
  const healthy = run();
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(JSON.parse(fs.readFileSync(database, 'utf8')).users.length, 2, 'valid production state survives the atomic startup save');
  const startupBackups = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.startsWith('automatic-startup-'));
  assert.equal(startupBackups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'backups', startupBackups[0]), 'utf8'), valid, 'the pre-migration database is preserved byte-for-byte');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Grit Boost combines hit and block bonus', () => {
  const boost = { boost_type: 'grit', rarity: 'rare', effect: { per: 1, bonus: 3 } };
  assert.equal(cards.boostFantasyBonus({ hits: 2, blocks: 4 }, boost), 18);
  const breakdown = cards.buildFantasyBreakdown({ goals: 0, assists: 0, shots: 0, hits: 2, blocks: 4 }, 'D', boost);
  assert.equal(breakdown.find(row => row.type === 'hit').boostBonus, 6);
  assert.equal(breakdown.find(row => row.type === 'block').boostBonus, 12);
});

test('chemistry requires both the same team and the same card season', () => {
  assert.equal(cards.wutChemistryKey({ edition: 'S1', teamId: 'MOFO' }), 'S1|MOFO');
  assert.equal(cards.wutChemistryKey({ edition: 'S1', teamId: 'mofo' }), 'S1|MOFO');
  assert.notEqual(cards.wutChemistryKey({ edition: 'S1', teamId: 'MOFO' }), cards.wutChemistryKey({ edition: 'S2', teamId: 'MOFO' }));
  assert.notEqual(cards.wutChemistryKey({ edition: 'S1', teamId: 'MOFO' }), cards.wutChemistryKey({ edition: 'S1', teamId: 'WEST' }));
  assert.equal(cards.wutChemistryKey({ cardType: 'mythic', sourceSeason: 'S1', teamId: 'MOFO' }), 'S1|MOFO');
});

test('S1 scoring reads the committed permanent synthetic game source', async () => {
  const result = await cards.scoreHistoricalCardSample({ player: { name: 'Shoe', baseName: 'Shoe', sourceSeason: 'S1' }, position: 'D' });
  assert.equal(result.gamesPlayed, 3);
  assert.ok(result.sampleMatchIds.every(id => id.startsWith('S1-WUT-')));
  assert.equal(new Set(result.sampleMatchIds).size, result.sampleMatchIds.length, 'original rolls must be unique');
  const bonus = await cards.scoreHistoricalCardSample({
    player: { name: 'Shoe', baseName: 'Shoe', sourceSeason: 'S1' },
    position: 'D',
    excludeMatchIds: result.sampleMatchIds
  });
  assert.equal(bonus.gamesPlayed, 3);
  assert.equal(new Set(bonus.sampleMatchIds).size, bonus.sampleMatchIds.length, 'bonus rolls must be unique');
  assert.equal(bonus.sampleMatchIds.some(id => result.sampleMatchIds.includes(id)), false, 'Lucky Charm bonus rolls cannot repeat an original game');

  const catalog = await cards.buildCardPlayerCatalog();
  const fosterPlayer = catalog.find(player => player.edition === 'S1' && player.baseName === 'Foster');
  assert.equal(fosterPlayer.position, 'G');
  const foster = await cards.scoreHistoricalCardSample({ player: fosterPlayer, position: fosterPlayer.position });
  assert.equal(foster.gamesPlayed, 3);
  assert.ok(foster.sampleMatchIds.every(id => id.startsWith('S1-WUT-name:Foster-')));

  const draftSnapshotPlayer = { name: 'S1 player 43', baseName: 'player 43', sourceSeason: 'S1' };
  const draftSnapshotResult = await cards.scoreHistoricalCardSample({ player: draftSnapshotPlayer, position: 'F' });
  assert.equal(draftSnapshotResult.gamesPlayed, 3, 'Draft display labels must not replace the permanent S1 player key');
  assert.ok(draftSnapshotResult.sampleMatchIds.every(id => id.startsWith('S1-WUT-name:player 43-')));
});

test('Draft card snapshots preserve and recover canonical Steam scoring identity', async () => {
  const catalog = await cards.buildCardPlayerCatalog();
  for (const name of ['Anvil', 'Nakesy']) {
    const player = catalog.find(item => item.edition === 'S2' && item.baseName === name);
    assert.ok(player?.sourceSteamId, `S2 ${name} must have a canonical Steam ID`);
    const snapshot = draftEvents.snapshotWutDraftCard(player);
    assert.equal(snapshot.displayName, `S2 ${name}`, 'the registered WCPL display name stays on the card');
    assert.equal(snapshot.sourceSteamId, player.sourceSteamId);
    assert.equal(snapshot.sourcePlayerKey, player.sourcePlayerKey);

    const legacySnapshot = {
      cardIdentity: player.cardIdentity, catalogKey: player.catalogKey,
      edition: player.edition, sourceSeason: player.sourceSeason, sourceStage: player.sourceStage,
      divisionId: player.divisionId, playerKey: player.playerKey,
      displayName: player.displayName, position: player.position, tier: player.tier
    };
    const hydrated = draftEvents.hydrateWutDraftCardPlayer(legacySnapshot, player);
    assert.equal(hydrated.sourceSteamId, player.sourceSteamId, 'an older Draft snapshot rehydrates through the normal catalog identity');
    const result = await cards.scoreHistoricalCardSample({ player: hydrated, position: hydrated.position });
    assert.equal(result.gamesPlayed, 3);
    assert.ok(result.rolledGames.every(game => game.steam_id === player.sourceSteamId));
  }
});

test('S1 catalog uses the canonical historical positions before rarity calculation', async () => {
  const catalog = (await cards.buildCardPlayerCatalog()).filter(player => player.edition === 'S1');
  assert.equal(Object.keys(cards.S1_CANONICAL_POSITIONS).length, 40);
  for (const [name, position] of Object.entries(cards.S1_CANONICAL_POSITIONS)) {
    const player = catalog.find(item => item.baseName.toLowerCase() === name);
    assert.ok(player, `${name} must exist in the S1 catalog`);
    assert.equal(player.position, position, `${name} must resolve to ${position}`);
  }
});

test('rarities use configurable FP/M thresholds across all seasons within exact positions', async () => {
  const catalog = (await cards.buildCardPlayerCatalog()).filter(player => player.cardType !== 'mythic' && player.position);
  for (const position of ['F', 'D', 'G']) {
    const allPositionCards = catalog.filter(player => player.position === position);
    assert.deepEqual([...new Set(allPositionCards.map(player => player.edition))].sort(), ['S1', 'S2', 'S3']);
    allPositionCards.forEach(player => {
      assert.equal(
        player.tier,
        cards.rarityForExpectedFp(player.expectedWutFpPerMatch, position, cards.DEFAULT_RARITY_THRESHOLDS),
        `${player.catalogKey} should use ${position} FP/M thresholds`
      );
      assert.equal(player.rarityEligible, true);
      assert.equal(player.rarityProvisional, undefined);
    });
  }
  const custom = await cards.buildCardPlayerCatalog({ rarityThresholds: { F: { uncommon: 1, rare: 2, epic: 3, legendary: 4 } } });
  assert.equal(custom.find(player => player.position === 'F' && player.expectedWutFpPerMatch >= 4)?.tier, 'legendary');
  const distribution = cards.buildRarityDistribution(catalog);
  assert.equal(distribution.F.total, catalog.filter(player => player.position === 'F').length);
  assert.ok(distribution.F.rarities.legendary.total > 0, 'forward thresholds should create legendary cards');
  assert.ok(catalog.every(player => Math.abs(player.expectedWutFpPerMatch - player.weightedFpPerGame * 3) < 1e-9));
});

test('mythic cards expose expected FP/M from their scoring source', async () => {
  const catalog = await cards.buildCardPlayerCatalog();
  const mythics = catalog.filter(player => player.cardType === 'mythic');
  const byName = new Map(mythics.map(player => [player.displayName, player]));
  assert.ok(byName.has('Champ Milk'));
  assert.ok(byName.has('Ruleset Sundin'));
  assert.ok(byName.get('Champ Milk').expectedWutFpPerMatch > 0);
  assert.ok(byName.get('Ruleset Sundin').expectedWutFpPerMatch > 0);
});

test('generated starter cards are unique Commons in a 2F / 2D / 1G lineup', async () => {
  const pack = cards.generateWutStarterPack(await cards.buildCardPlayerCatalog());
  assert.equal(pack.length, 5);
  assert.equal(new Set(pack.map(item => item.cardIdentity)).size, 5);
  assert.ok(pack.every(item => item.itemType === 'player' && item.rolledTier === 'common'));
  assert.equal(pack.map(item => item.position).sort().join(''), 'DDFFG');
});

test('Premium and Prestige packs guarantee a Rare-or-better player', () => {
  const catalog = [
    ['common-one', 'common'], ['common-two', 'common'], ['common-three', 'common'],
    ['rare-one', 'rare'], ['epic-one', 'epic']
  ].map(([catalogKey, tier], index) => ({
    catalogKey, cardIdentity: catalogKey, tier, position: index % 2 ? 'D' : 'F',
    edition: 'S1', divisionId: 'test', playerKey: catalogKey, displayName: catalogKey
  }));
  const commonOnlyOdds = { common: 100, uncommon: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 };
  const config = { playerTierOdds: { standard: commonOnlyOdds, premium: commonOnlyOdds, prestige: commonOnlyOdds } };

  for (const packType of ['premium', 'prestige']) {
    const players = cards.generatePlayerPack({ packType, catalog, config });
    assert.equal(players.length, 3);
    assert.ok(players.some(player => cards.CARD_STARS[player.rolledTier] >= cards.CARD_STARS.rare));
  }

  const noExactRareCatalog = catalog.filter(player => player.tier !== 'rare');
  const rareOnlyOdds = { common: 0, uncommon: 0, rare: 100, epic: 0, legendary: 0, mythic: 0 };
  const fallbackPlayers = cards.generatePlayerPack({
    packType: 'premium', catalog: noExactRareCatalog,
    config: { playerTierOdds: { standard: commonOnlyOdds, premium: rareOnlyOdds } }
  });
  assert.ok(fallbackPlayers.some(player => cards.CARD_STARS[player.rolledTier] >= cards.CARD_STARS.rare));
});

test('S3 player pack eligibility requires at least six games played', () => {
  assert.equal(cards.isPlayerPackEligible({ edition: 'S3', position: 'F', tier: 'common', editionStats: { games: 5 } }), false);
  assert.equal(cards.isPlayerPackEligible({ edition: 'S3', position: 'F', tier: 'common', editionStats: { games: 6 } }), true);
  assert.equal(cards.isPlayerPackEligible({ edition: 'S2', position: 'F', tier: 'common', editionStats: { games: 1 } }), true);
  assert.equal(cards.isPlayerPackEligible({ edition: 'MYTHIC', cardType: 'mythic', position: 'G', tier: 'mythic' }), true);
});

test('arena matchmaking globally minimizes ELO gaps and skips only the newest odd entrant', () => {
  const entries = [
    { id: 1, user_id: 1, elo: 1100, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 2, user_id: 2, elo: 1000, created_at: '2026-01-01T00:01:00.000Z' },
    { id: 3, user_id: 3, elo: 1110, created_at: '2026-01-01T00:02:00.000Z' },
    { id: 4, user_id: 4, elo: 1120, created_at: '2026-01-01T00:03:00.000Z' },
    { id: 5, user_id: 5, elo: 1090, created_at: '2026-01-01T00:04:00.000Z' }
  ];
  const result = db.pairArenaQueueEntriesByElo(entries, entry => entry.elo);
  assert.equal(result.unmatched.user_id, 5, 'the newest entrant must be the only skipped player');
  assert.deepEqual(result.pairs.map(pair => pair.map(entry => entry.user_id)), [[2, 1], [3, 4]]);
  assert.equal(result.pairs.reduce((sum, [a, b]) => sum + Math.abs(a.elo - b.elo), 0), 110);

  const even = db.pairArenaQueueEntriesByElo(entries.slice(0, 4), entry => entry.elo);
  assert.equal(even.unmatched, null);
  assert.deepEqual(even.pairs.map(pair => pair.map(entry => entry.user_id)), [[2, 1], [3, 4]]);
});

test('arena matchmaking avoids prior opponents before minimizing ELO gaps', () => {
  const entries = [
    { id: 1, user_id: 1, elo: 1000, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 2, user_id: 2, elo: 1001, created_at: '2026-01-01T00:01:00.000Z' },
    { id: 3, user_id: 3, elo: 1100, created_at: '2026-01-01T00:02:00.000Z' },
    { id: 4, user_id: 4, elo: 1101, created_at: '2026-01-01T00:03:00.000Z' }
  ];
  const prior = new Set(['1:2', '3:4']);
  const havePlayed = (a, b) => prior.has([a.user_id, b.user_id].sort((x, y) => x - y).join(':'));
  const result = db.pairArenaQueueEntriesByElo(entries, entry => entry.elo, havePlayed);
  assert.ok(result.pairs.every(([a, b]) => !havePlayed(a, b)), 'a complete fresh-opponent pairing exists');
  assert.deepEqual(result.pairs.map(pair => pair.map(entry => entry.user_id)), [[1, 3], [2, 4]]);

  const onlyPair = db.pairArenaQueueEntriesByElo(entries.slice(0, 2), entry => entry.elo, havePlayed);
  assert.deepEqual(onlyPair.pairs.map(pair => pair.map(entry => entry.user_id)), [[1, 2]], 'a rematch is allowed when no alternative exists');
});

test('committed match cards are removed from that player’s available deck', () => {
  const available = cards.availableWutMatchCards(
    [
      { id: 10, card_identity: 'S1|ALL|name:one' },
      { id: 11, card_identity: 'S1|ALL|name:two' },
      { id: 12, card_identity: 'S1|ALL|name:one' },
      { id: 13, card_identity: 'S1|ALL|name:three' }
    ],
    [
      { user_id: 1, card_id: 10, card_snapshot: { card_identity: 'S1|ALL|name:one' } },
      { user_id: 2, card_id: 11, card_snapshot: { card_identity: 'S1|ALL|name:two' } }
    ],
    1
  );
  assert.deepEqual(available.map(card => card.id), [11, 13], 'other owned copies of a committed identity must also be hidden');
});

function saveConstructedTestDeck(userId, prefix, catalogByIdentity = {}) {
  const starterPositions = ['F', 'F', 'D', 'D', 'G'];
  const starterIds = db.getWutMembershipState(userId).starterCardIds.map(Number);
  const ownedBefore = new Map(db.getCardsOwnedState(userId).cards.map(card => [Number(card.id), card]));
  const timestamp = Date.now();
  const extraCards = ['F', 'D', 'G'].map((position, index) => db.grantCardsTestItem({
    userId,
    item: {
      itemType: 'player', rolledTier: 'common', position,
      cardIdentity: `S3|${prefix}|extra-${userId}-${index}-${timestamp}`,
      catalogKey: `S3|${prefix}|extra-${userId}-${index}-${timestamp}`,
      edition: 'S3', divisionId: prefix, playerKey: `extra-${userId}-${index}`
    }
  }));
  const deckIds = [...starterIds, ...extraCards.map(card => Number(card.id))];
  const owned = new Map([...ownedBefore.values(), ...extraCards].map(card => [Number(card.id), card]));
  deckIds.forEach((id, index) => {
    const card = owned.get(Number(id));
    const position = index < starterPositions.length ? starterPositions[index] : extraCards[index - starterPositions.length].position;
    catalogByIdentity[card.card_identity] = {
      position, tier: 'common', teamId: `${prefix}-${position}-${index}`,
      teamName: `${prefix} ${position} ${index}`, edition: 'S3', name: `${prefix} ${index}`
    };
  });
  return db.saveWutDeck({ userId, name: `${prefix} Test Deck`, activeCardIds: deckIds, catalogByIdentity });
}

let arenaQueueFixtureIndex = 0;
function createWutReadyUser(prefix, catalogByIdentity = {}) {
  arenaQueueFixtureIndex += 1;
  const user = db.addUser({
    username: `${prefix.toLowerCase()}-${arenaQueueFixtureIndex}`,
    password: 'test-password',
    displayName: `${prefix} ${arenaQueueFixtureIndex}`
  });
  db.joinWut(user.id);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  const items = positions.map((position, index) => ({
    itemType: 'player', rolledTier: 'common', position,
    cardIdentity: `S3|${prefix}-${arenaQueueFixtureIndex}|starter-${index}`,
    catalogKey: `S3|${prefix}-${arenaQueueFixtureIndex}|starter-${index}`,
    edition: 'S3', divisionId: `${prefix}-${arenaQueueFixtureIndex}`, playerKey: `starter-${index}`
  }));
  db.openWutStarterPack({ userId: user.id, items });
  for (const item of items) catalogByIdentity[item.cardIdentity] = {
    position: item.position, tier: 'common', teamId: `${prefix}-${arenaQueueFixtureIndex}`, edition: 'S3',
    name: `${prefix} starter ${item.playerKey}`
  };
  return user;
}

function chooseFirstForConstructedMatch(match, choice = 'self') {
  if (match?.status !== 'choosing_first') return match;
  return db.chooseArenaFirstPlayer({
    userId: match.first_player_decider_user_id,
    matchId: match.id,
    choice
  });
}

function playConstructedSeriesToReady(userId, catalogByIdentity, winnerUserId = userId) {
  while (true) {
    let match = db.getArenaStateForUser(userId).activeMatches[0];
    match = chooseFirstForConstructedMatch(match) || match;
    const matchId = match.id;
    while (true) {
      const arena = db.getArenaStateForUser(userId);
      match = arena.activeMatches[0];
      if (!match || match.status !== 'active') break;
      const current = Number(match.current_player_id);
      const snapshots = match.deck_snapshots[String(current)].active;
      const usedCards = new Set(match.placements.filter(row => Number(row.user_id) === current).map(row => Number(row.card_id)));
      const usedSlots = new Set(match.placements.filter(row => Number(row.user_id) === current).map(row => row.slot));
      const openSlots = ['F1', 'F2', 'D1', 'D2', 'G'].filter(slot => !usedSlots.has(slot));
      const placements = [];
      for (const slot of openSlots) {
        const position = slot === 'G' ? 'G' : slot[0];
        const card = snapshots.find(item => item.position === position && !usedCards.has(Number(item.card_id)));
        if (!card) continue;
        placements.push({ slot, cardId: card.card_id });
        usedCards.add(Number(card.card_id));
        if (placements.length === Number(match.cards_required_this_turn)) break;
      }
      db.commitArenaTurn({ userId: current, matchId: match.id, placements, catalogByIdentity });
    }
    const scoring = db.getArenaMatchesNeedingScoring().find(item => Number(item.id) === Number(matchId));
    assert.ok(scoring);
    const completed = db.completeArenaMatch(scoring.id, scoring.placements.map(row => ({
      ...row,
      fp: Number(row.user_id) === Number(winnerUserId) ? 20 : 10
    })));
    if (completed.status === 'ready') {
      db.completeArenaReveal(userId, completed.id);
      const opponentId = completed.player_ids.map(Number).find(id => id !== Number(userId));
      db.completeArenaReveal(opponentId, completed.id);
      const afterReveal = db.getArenaStateForUser(userId).history.find(item => Number(item.id) === Number(completed.id));
      if (afterReveal?.series_pending_next_game) {
        db.advanceArenaConstructedSeries({ userId, matchId: completed.id });
        continue;
      }
      return afterReveal || completed;
    }
  }
}

test('new WUT users receive the complete starter bundle', () => {
  db.initDb();
  db.joinWut(1);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  const items = positions.map((position, index) => ({ itemType: 'player', rolledTier: 'common', position, cardIdentity: `S3|D1|starter-${index}`, catalogKey: `S3|D1|starter-${index}`, edition: 'S3', divisionId: 'D1', playerKey: `starter-${index}` }));
  db.openWutStarterPack({ userId: 1, items });
  const state = db.getWutSystemsState(1);
  assert.deepEqual(db.getCardsConfig().playerPackPrices, { standard: 250, premium: 500, prestige: 1000 });
  assert.deepEqual(db.getCardsConfig().boostPack, {
    price: 250,
    commonRareRolls: 4,
    guaranteedHighRolls: 1,
    commonRareOdds: { common: 55, uncommon: 30, rare: 15 },
    guaranteedHighOdds: { epic: 85, legendary: 15 }
  });
  assert.deepEqual(db.getCardsConfig().wut.trinketPrices, { common: 100, uncommon: 250, rare: 500, epic: 1000, legendary: 2000 });
  assert.deepEqual(db.getCardsConfig().wut.trinketRemovalWut, { common: 25, uncommon: 75, rare: 150, epic: 300, legendary: 500 });
  assert.deepEqual(db.getCardsConfig().wut.shopReroll, { wut: 200, mushy: 500 });
  assert.deepEqual(db.getCardsConfig().wut.trinketShopOdds, {
    1: { common: 100, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    2: { common: 0, uncommon: 75, rare: 25, epic: 0, legendary: 0 },
    3: { common: 0, uncommon: 0, rare: 0, epic: 85, legendary: 15 }
  });
  assert.deepEqual(db.getCardsAdminState().config.scoring.chemistryBonuses, { 2: 10, 3: 15, 4: 20, 5: 25 });
  assert.equal(state.deckSlots, 3);
  assert.equal(state.decks.length, 0, 'starter packs grant cards, but Constructed decks are built explicitly');
  assert.equal(state.trinkets.length, 2);
  assert.ok(state.trinkets.every(trinket => trinket.rarity === 'common' && trinket.source === 'starter_pack'));
  assert.equal(new Set(state.trinkets.map(trinket => trinket.family)).size, 2);
  assert.equal(db.getWutMembershipState(1).wutCoins, 1000);
  assert.throws(() => db.openWutStarterPack({ userId: 1, items }), /already been opened/);
  assert.equal(db.getWutMembershipState(1).wutCoins, 1000, 'the starter coin grant cannot be claimed twice');
  const starterBonus = db.getPendingCardsPack(1);
  assert.equal(starterBonus.pack_type, 'standard');
  assert.equal(starterBonus.source, 'starter_bonus');
  assert.equal(starterBonus.price, 0);
  assert.equal(starterBonus.items.filter(item => item.itemType === 'player').length, 3);
  assert.equal(starterBonus.items.filter(item => item.itemType === 'boost').length, 2);
  assert.ok(state.shop.offers.every(offer => offer.effect != null));
  db.claimCardsPack(1, starterBonus.id);
  db.setWutFreeShopPurchases(true);
  const freeTrinket = db.buyWutTrinket({ userId: 1, slot: state.shop.offers[0].slot });
  assert.ok(freeTrinket.id);
  assert.equal(db.getWutMembershipState(1).wutCoins, 1000);
  const freeReroll = db.rerollWutTrinketShop({ userId: 1, currency: 'wut' });
  assert.equal(freeReroll.offers.length, 3);
  assert.equal(db.getWutMembershipState(1).wutCoins, 1000);
  const boostPurchase = db.createCardsPackPurchase({ userId: 1, week: 1, packKind: 'boost', packType: 'boost', price: 250, items: [
    { itemType: 'boost', boostType: 'goal', rarity: 'common' },
    { itemType: 'boost', boostType: 'assist', rarity: 'common' },
    { itemType: 'boost', boostType: 'shot', rarity: 'uncommon' },
    { itemType: 'boost', boostType: 'grit', rarity: 'rare' },
    { itemType: 'boost', boostType: 'save', rarity: 'legendary' }
  ] });
  assert.equal(boostPurchase.pack_kind, 'boost');
  assert.equal(boostPurchase.price, 0);
  assert.equal(boostPurchase.free_purchase, true);
  assert.equal(db.claimCardsPack(1, boostPurchase.id).filter(item => item.itemType === 'boost').length, 5);
  assert.equal(db.getWutMembershipState(1).wutCoins, 1000);
  const purchase = db.createCardsPackPurchase({ userId: 1, week: 1, packKind: 'player', packType: 'standard', price: 250, items: [
    ...items.slice(0, 3),
    { itemType: 'boost', boostType: 'goal', rarity: 'common' },
    { itemType: 'boost', boostType: 'grit', rarity: 'common' }
  ] });
  assert.equal(purchase.price, 0);
  assert.equal(purchase.free_purchase, true);
  assert.equal(db.getWutMembershipState(1).wutCoins, 1000);

  const cardIds = db.getWutMembershipState(1).starterCardIds;
  const catalogByIdentity = Object.fromEntries(items.map(item => [item.cardIdentity, { position: item.position, tier: 'common', teamId: 'TEST' }]));
  db.resetWutDebugMatch(1);
  const slots = ['F1', 'F2', 'D1', 'D2', 'G'];
  for (const side of ['A', 'B']) slots.forEach((slot, index) => db.commitWutDebugPlacement({ adminUserId: 1, side, slot, cardId: cardIds[index], catalogByIdentity }));
  const pendingDebug = db.getWutDebugMatch(1);
  assert.equal(pendingDebug.status, 'scoring');
  assert.equal(db.getArenaMatchesNeedingScoring().some(match => match.id === pendingDebug.id), true);
  db.completeArenaMatch(pendingDebug.id, pendingDebug.placements.map(row => ({ ...row, fp: row.debug_side === 'A' ? 10 : 5 })));
  const completedDebug = db.getWutDebugMatch(1);
  assert.equal(completedDebug.status, 'completed');
  assert.equal(completedDebug.winner_side, 'A');
  assert.equal(db.getWutMembershipState(1).wutCoins, 1000, 'debug games never award currency');
});

test('betting leaderboard is sportsbook net only and may be negative', () => {
  const user = db.addUser({ username: 'sportsbook-net-user', password: 'test-password', displayName: 'Sportsbook Net User' });
  db.adjustUserBalance(user.id, 5000, 'must not affect betting performance');
  let row = db.getLeaderboard(77, false).find(entry => entry.id === user.id);
  assert.equal(row.total_balance, 0, 'starting balances and manual adjustments are excluded');
  assert.equal(row.balance_display, '0');

  db.placeOrUpdateBet({
    userId: user.id, week: 77, divisionId: 'D1', seriesKey: 'NET-WIN', marketKey: 'NET-WIN|series_win|A',
    marketType: 'series_win', teamId: 'A', label: 'Net test winner', stake: 100, multiplier: 2
  });
  row = db.getLeaderboard(77, false).find(entry => entry.id === user.id);
  assert.equal(row.total_balance, -100, 'an open wager counts as paid stake');
  assert.equal(row.current_week_change, -100);
  assert.equal(row.balance_display, '-100');

  const winningBet = db.getUserBets(user.id, 1)[0];
  db.settleWeek({ week: 77, results: { evaluations: { [winningBet.id]: { ready: true, won: true } } } });
  row = db.getLeaderboard(77, false).find(entry => entry.id === user.id);
  assert.equal(row.total_balance, 100, 'a settled win is payout minus stake');
  assert.equal(row.current_week_change, 100);

  db.placeOrUpdateBet({
    userId: user.id, week: 78, divisionId: 'D1', seriesKey: 'NET-LOSS', marketKey: 'NET-LOSS|series_win|B',
    marketType: 'series_win', teamId: 'B', label: 'Net test loser', stake: 250, multiplier: 2
  });
  const losingBet = db.getUserBets(user.id, 1)[0];
  db.settleWeek({ week: 78, results: { evaluations: { [losingBet.id]: { ready: true, won: false } } } });
  row = db.getLeaderboard(78, false).find(entry => entry.id === user.id);
  assert.equal(row.total_balance, -150, 'all-time betting net can remain negative despite a positive real balance');
  assert.equal(row.current_week_change, -250);
  assert.equal(row.last_week_change, 100);
});

test('settled bet corrections apply only the payout delta and are idempotent', () => {
  const user = db.addUser({ username: 'settlement-correction-user', password: 'test-password', displayName: 'Settlement Correction User' });
  db.placeOrUpdateBet({
    userId: user.id, week: 79, divisionId: 'D1', seriesKey: 'CORRECTION', marketKey: 'CORRECTION|series_win|A',
    marketType: 'series_win', teamId: 'A', label: 'Correction test', stake: 100, multiplier: 2.5
  });
  const bet = db.getUserBets(user.id, 1)[0];
  db.settleWeek({ week: 79, results: { evaluations: { [bet.id]: { ready: true, won: false, result_summary: 'Initial stale result' } } } });
  const before = db.getBalanceSummaryForUser(user.id).available_balance;

  const corrected = db.correctSettledBet({
    betId: bet.id,
    week: 79,
    evaluation: { ready: true, won: true, result_summary: 'Final boxscore result' },
    adminUserId: 1
  });
  assert.equal(corrected.delta, 250);
  assert.equal(db.getBalanceSummaryForUser(user.id).available_balance, before + 250);
  assert.equal(db.getAdminSettledBets().find(item => item.id === bet.id).payout, 250);
  assert.throws(() => db.correctSettledBet({
    betId: bet.id,
    week: 79,
    evaluation: { ready: true, won: true, result_summary: 'Final boxscore result' },
    adminUserId: 1
  }), /already correct/);

  const reversed = db.correctSettledBet({
    betId: bet.id,
    week: 79,
    evaluation: { ready: true, won: false, result_summary: 'Corrected again' },
    adminUserId: 1
  });
  assert.equal(reversed.delta, -250);
  assert.equal(db.getBalanceSummaryForUser(user.id).available_balance, before);
});

test.skip('the same season player cannot be played from both Active Deck and Safety Bench', () => {
  const target = db.addUser({ username: 'cross-deck-duplicate-a', password: 'test-password', displayName: 'Cross Deck A' });
  const opponent = db.addUser({ username: 'cross-deck-duplicate-b', password: 'test-password', displayName: 'Cross Deck B' });
  const positions = ['F', 'F', 'D', 'D', 'G'];
  const catalogByIdentity = {};
  for (const user of [target, opponent]) {
    db.joinWut(user.id);
    const items = positions.map((position, index) => ({
      itemType: 'player', rolledTier: 'common', position,
      cardIdentity: `S3|DUP-${user.id}|player-${index}`, catalogKey: `S3|DUP-${user.id}|player-${index}`,
      edition: 'S3', divisionId: `DUP-${user.id}`, playerKey: `player-${index}`
    }));
    db.openWutStarterPack({ userId: user.id, items });
    items.forEach(item => { catalogByIdentity[item.cardIdentity] = { position: item.position, tier: 'common', teamId: item.divisionId }; });
  }
  const targetDeck = db.getWutSystemsState(target.id).decks[0];
  const targetCards = db.getCardsOwnedState(target.id).cards;
  const originalForward = targetCards.find(card => Number(card.id) === Number(targetDeck.active_card_ids[0]));
  const duplicateForward = db.grantCardsTestItem({
    userId: target.id,
    item: {
      itemType: 'player', rolledTier: 'common', position: 'F',
      cardIdentity: originalForward.card_identity, catalogKey: originalForward.card_identity,
      edition: 'S3', divisionId: `DUP-${target.id}`, playerKey: 'player-0'
    }
  });
  const crossDeck = db.saveWutDeck({
    userId: target.id, deckId: targetDeck.id, name: targetDeck.name,
    activeCardIds: targetDeck.active_card_ids,
    benchCardIds: [duplicateForward.id, ...targetDeck.bench_card_ids.slice(1)],
    catalogByIdentity
  });
  const oldRandom = Math.random;
  Math.random = () => 0;
  try {
    db.enterArenaQueue(target.id, crossDeck.id, catalogByIdentity);
    db.enterArenaQueue(opponent.id, db.getWutSystemsState(opponent.id).decks[0].id, catalogByIdentity);
    db.assignArenaMatchups();
  } finally {
    Math.random = oldRandom;
  }
  const match = db.getArenaStateForUser(target.id).activeMatches[0];
  assert.equal(match.current_player_id, target.id);
  db.commitArenaTurn({ userId: target.id, matchId: match.id, placements: [{ slot: 'F1', cardId: originalForward.id }], catalogByIdentity });
  const opponentView = db.getArenaStateForUser(opponent.id).activeMatches.find(item => item.id === match.id);
  const opponentForwards = opponentView.deck_snapshots[String(opponent.id)].active.filter(card => card.position === 'F');
  db.commitArenaTurn({ userId: opponent.id, matchId: match.id, placements: [{ slot: 'F1', cardId: opponentForwards[0].card_id }, { slot: 'F2', cardId: opponentForwards[1].card_id }], catalogByIdentity });
  const targetDefense = match.deck_snapshots[String(target.id)].active.find(card => card.position === 'D');
  assert.throws(() => db.commitArenaTurn({
    userId: target.id, matchId: match.id,
    placements: [{ slot: 'F2', cardId: duplicateForward.id }, { slot: 'D1', cardId: targetDefense.card_id }],
    catalogByIdentity
  }), /already in this lineup/);
  assert.equal(db.getArenaStateForUser(target.id).activeMatches.find(item => item.id === match.id).placements.filter(row => Number(row.user_id) === Number(target.id)).length, 1);
});

function createDraftTournamentFixture({ name, entrantCount, tournament, match = {}, deckbuilding = {} }) {
  const userIds = [1];
  for (let index = 1; index < entrantCount; index += 1) {
    const user = db.addUser({ username: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}-${Date.now()}`, password: 'test-password', displayName: `${name} Player ${index + 1}` });
    db.joinWut(user.id);
    db.openWutStarterPack({ userId: user.id, items: ['F', 'F', 'D', 'D', 'G'].map((position, cardIndex) => ({ itemType: 'player', rolledTier: 'common', position, cardIdentity: `S3|${name}|USER${index}|${cardIndex}`, catalogKey: `S3|${name}|USER${index}|${cardIndex}`, edition: 'S3', divisionId: name, playerKey: `${index}-${cardIndex}` })) });
    userIds.push(user.id);
  }
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name, entryFee: { currency: 'free', amount: 0 }, minimumEntrants: entrantCount, maximumEntrants: entrantCount, allowOddEntrants: true, visibility: 'private' },
      safetyBench: { mode: 'disabled' },
      boosters: { countPerPlayer: 1, contents: { players: 1, boosts: 0, trinkets: 0 }, rarityOdds: { players: { common: 100 } }, pool: { allowDuplicateInBooster: false, allowDuplicateInEvent: true } },
      draft: { pickSeconds: 30, autopick: { enabled: true, priority: ['player', 'rarity', 'random'] } },
      deckbuilding: { seconds: 300, deckSize: 1, activeMinimum: 1, activeMaximum: 1, ...deckbuilding },
      tournament: { automaticNextRound: true, betweenRoundSeconds: 0, ...tournament },
      match: { turnSeconds: 300, openingTimeout: 'forfeit', laterTimeout: 'forfeit', boostLoadCap: 5, boostsMode: 'tournament_consumable', simultaneousMatches: true, ...match },
      prizes: { tiers: [] }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  userIds.forEach(userId => db.joinWutDraftEvent({ eventId: event.id, userId }));
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const pool = [
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|${name}|F${index}`, displayName: `${name} F${index}`, edition: 'S3', position: 'F', tier: 'common' })),
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|${name}|D${index}`, displayName: `${name} D${index}`, edition: 'S3', position: 'D', tier: 'common' })),
    ...Array.from({ length: 2 }, (_, index) => ({ cardIdentity: `S3|${name}|G${index}`, displayName: `${name} G${index}`, edition: 'S3', position: 'G', tier: 'common' }))
  ];
  const config = db.getCardsConfig();
  db.startWutDraftEvent({ eventId: event.id, environment: { cards: pool, rules: { scoring: config.scoring, boostEffects: config.boostEffects, trinketEffects: config.wut.trinketEffects, rarityCosts: config.wut.rarityCosts, trinketPowerValues: config.wut.trinketPowerValues, slotPowerAllowance: config.wut.slotPowerAllowance } }, adminUserId: 1 });
  db.beginWutDraftEvent({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  while (db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase === 'draft') db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  let current = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  for (const userId of userIds) {
    const inventory = current.inventories[String(userId)];
    const drafted = inventory.cards[0];
    db.saveWutDraftEventDeck({ eventId: event.id, userId, activeCardIds: [drafted.id] });
  }
  return { eventId: event.id, userIds };
}

test('draft event foundation persists configurable events, presets, phases, and audit logs', () => {
  const nightly = db.getWutDraftEventPresets().find(preset => preset.key === 'nightly-booster-draft');
  assert.ok(nightly?.system);
  assert.equal(nightly.config.boosters.countPerPlayer, 3, 'Nightly values belong to a preset, not engine constants');

  const config = draftEvents.normalizeWutDraftEventConfig({
    basic: {
      name: 'Seven Player Trinket Madness', entryFee: { currency: 'free', amount: 999 },
      minimumEntrants: 3, maximumEntrants: 7, allowOddEntrants: true, visibility: 'private', allowManualStartBelowMinimum: true
    },
    safetyBench: { mode: 'random_shared', rarityMin: 'common', rarityMax: 'uncommon' },
    boosters: {
      countPerPlayer: 4, contents: { players: 4, boosts: 2, trinkets: 5 },
      rarityOdds: {
        players: { common: 100 }, boosts: { rare: 100 }, trinkets: { legendary: 100 }
      }
    },
    draft: { pickSeconds: 25, passDirections: ['right'] },
    tournament: { format: 'round_robin', roundRobin: { meetings: 2 } },
    match: { turnSeconds: 300, boostsMode: 'refresh_each_match' },
    prizes: { tiers: [{ key: 'participants', label: 'Everyone', participant: true, rewards: [{ type: 'wut_coins', amount: 25 }] }] }
  });
  assert.equal(config.basic.entryFee.amount, 0);
  assert.deepEqual(config.draft.passDirections, ['right', 'right', 'right', 'right']);
  assert.deepEqual(config.boosters.contents, { players: 4, boosts: 2, trinkets: 5 });
  assert.equal(config.tournament.roundRobin.meetings, 2);

  const preset = db.saveWutDraftEventPreset({
    name: 'Trinket Madness', description: 'Reusable odd-player event', config, adminUserId: 1
  });
  const event = db.createWutDraftEvent({ presetId: preset.id, adminUserId: 1 });
  assert.equal(event.phase, 'scheduled');
  assert.equal(event.config.basic.maximumEntrants, 7);
  assert.deepEqual(event.inventories, {});
  assert.ok(event.logs.some(entry => entry.type === 'event_created'));
  assert.ok(event.logs.some(entry => entry.type === 'preset_loaded'));
  assert.equal(db.getWutDraftEvents().some(item => item.id === event.id), false, 'private events stay out of public listings');
  assert.equal(db.getWutDraftEvents({ includePrivate: true }).some(item => item.id === event.id), true);

  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const paused = db.pauseWutDraftEvent({ eventId: event.id, adminUserId: 1, reason: 'Intermission' });
  assert.ok(paused.paused_at);
  assert.throws(() => db.startWutDraftEvent({ eventId: event.id, environment: { cards: [] }, adminUserId: 1 }), /Resume/);
  const resumed = db.resumeWutDraftEvent({ eventId: event.id, adminUserId: 1 });
  assert.equal(resumed.paused_at, null);
  const benchCards = ['F','F','F','F','D','D','D','D','G','G'].map((position, index) => ({ cardIdentity: `S3|BENCH|${index}`, tier: 'common', position }));
  const starting = db.startWutDraftEvent({ eventId: event.id, environment: { cards: [{ cardIdentity: 'S3|TEST|one', tier: 'common' }], bench_cards: benchCards, rules: { marker: 'frozen' } }, adminUserId: 1 });
  assert.equal(starting.phase, 'starting');
  assert.equal(starting.environment_snapshot.rules.marker, 'frozen');
  assert.ok(starting.logs.some(entry => entry.type === 'event_paused'));
  assert.ok(starting.logs.some(entry => entry.type === 'event_resumed'));
  assert.throws(() => db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'tournament', adminUserId: 1 }), /Cannot move/);
});

test('admin can close signup and start a Draft Event early in one flow', () => {
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name: 'Early Start Test', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 4, allowOddEntrants: true, allowManualStartBelowMinimum: true, visibility: 'private' },
      safetyBench: { mode: 'disabled' },
      boosters: { countPerPlayer: 1, contents: { players: 1, boosts: 0, trinkets: 0 }, rarityOdds: { players: { common: 100 } } }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 });
  const cardsPool = [0, 1, 2].map(index => ({ cardIdentity: `S3|EARLY|${index}`, displayName: `Early ${index}`, edition: 'S3', position: index === 2 ? 'D' : 'F', tier: 'common' }));
  const starting = db.startWutDraftEvent({ eventId: event.id, environment: { cards: cardsPool, rules: {} }, adminUserId: 1, startNow: true });
  assert.equal(starting.phase, 'starting');
  assert.ok(starting.logs.some(row => row.type === 'phase_changed' && row.details?.to === 'signup_closed'));
  const live = db.beginWutDraftEvent({ eventId: event.id, adminUserId: 1 });
  assert.equal(live.phase, 'draft');
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'cancelled', adminUserId: 1, reason: 'Early-start test complete' });
});

test('every seat receives the same per-round draft booster composition blueprint', () => {
  const config = draftEvents.normalizeWutDraftEventConfig({
    boosters: {
      countPerPlayer: 2, contents: { players: 6, boosts: 3, trinkets: 1 },
      rarityOdds: {
        players: { common: 60, rare: 30, epic: 10 },
        boosts: { rare: 80, legendary: 20 },
        trinkets: { uncommon: 100 }
      },
      guarantees: { rarePlusPlayerPerBooster: true }
    },
    draft: { passDirections: ['left', 'right'] }
  });
  const rolls = [0.01, 0.2, 0.4, 0.7, 0.8, 0.95, 0.1, 0.9, 0.2, 0.4];
  let rollIndex = 0;
  const templates = draftEvents.buildWutDraftBoosterRoundTemplates(config, () => rolls[(rollIndex++) % rolls.length]);
  assert.equal(templates.length, 2);
  for (const template of templates) {
    assert.deepEqual(
      template.slots.reduce((counts, slot) => ({ ...counts, [slot.itemType]: (counts[slot.itemType] || 0) + 1 }), {}),
      { player: 6, boost: 3, trinket: 1 }
    );
    assert.ok(template.slots.some(slot => slot.itemType === 'player' && ['rare', 'epic', 'legendary'].includes(slot.rarity)));
    const packs = draftEvents.instantiateWutDraftBoosterTemplate(template, [1, 2, 3, 4, 5]);
    assert.equal(packs.length, 5);
    assert.ok(packs.every(pack => JSON.stringify(pack.composition) === JSON.stringify(packs[0].composition)));
  }
  assert.deepEqual(templates.map(template => template.passDirection), ['left', 'right']);
});

test.skip('Draft Event Safety Bench always uses Common cards from eligible seasons independently of booster rarities', () => {
  const config = draftEvents.normalizeWutDraftEventConfig({
    safetyBench: { rarityMin: 'legendary', rarityMax: 'legendary' },
    boosters: {
      pool: { seasons: ['S1', 'S2'], positions: ['F', 'D', 'G'], rarities: ['uncommon', 'rare', 'epic', 'legendary'] },
      rarityLimits: { players: { minimum: 'uncommon', maximum: 'legendary' } }
    }
  });
  assert.equal(config.safetyBench.rarityMin, 'common');
  assert.equal(config.safetyBench.rarityMax, 'common');
  const catalog = [
    { cardIdentity: 'S1|A|common', edition: 'S1', position: 'F', tier: 'common' },
    { cardIdentity: 'S2|A|common', edition: 'S2', position: 'D', tier: 'common' },
    { cardIdentity: 'S1|A|rare', edition: 'S1', position: 'G', tier: 'rare' },
    { cardIdentity: 'S3|A|common', edition: 'S3', position: 'G', tier: 'common' },
    { cardIdentity: 'S1|A|jurkey', edition: 'S1', baseName: 'jurkey', position: 'F', tier: 'common' },
    { cardIdentity: 'S2|A|bleh', edition: 'S2', baseName: 'bleh', position: 'D', tier: 'common' },
    { cardIdentity: 'S1|A|renamed-jurkey', edition: 'S1', baseName: 'Different Name', sourceSteamId: '76561199027789459', position: 'G', tier: 'rare' }
  ];
  const pools = draftEvents.splitWutDraftCardPools(config, catalog);
  assert.deepEqual(pools.boosterCards.map(card => card.cardIdentity), ['S1|A|rare']);
  assert.deepEqual(pools.benchCards.map(card => card.cardIdentity), ['S1|A|common', 'S2|A|common']);
});

test('draft signup charges once, withdrawal and cancellation refund once, and start freezes the environment', () => {
  const startingCoins = db.getWutMembershipState(1).wutCoins;
  db.adjustWutCoinBalance({ userId: 1, amount: 1000, note: 'Draft flow test', adminUserId: 1 });
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: {
        name: 'Refundable Draft Test', entryFee: { currency: 'wut_coin', amount: 200 },
        minimumEntrants: 2, maximumEntrants: 4, allowOddEntrants: true,
        allowManualStartBelowMinimum: true, visibility: 'public'
      }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1, now: new Date('2026-07-04T18:00:00Z') });
  assert.equal(db.getWutMembershipState(1).wutCoins, startingCoins + 800);
  assert.throws(() => db.joinWutDraftEvent({ eventId: event.id, userId: 1 }), /already entered/);

  db.withdrawWutDraftEvent({ eventId: event.id, userId: 1, now: new Date('2026-07-04T18:01:00Z') });
  assert.equal(db.getWutMembershipState(1).wutCoins, startingCoins + 1000);
  db.joinWutDraftEvent({ eventId: event.id, userId: 1, now: new Date('2026-07-04T18:02:00Z') });
  assert.equal(db.getWutMembershipState(1).wutCoins, startingCoins + 800);
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });

  const environment = {
    cards: [{ cardIdentity: 'S3|D1|frozen', tier: 'rare' }],
    bench_cards: ['F','F','F','F','D','D','D','D','G','G'].map((position, index) => ({ cardIdentity: `S3|REFUNDBENCH|${index}`, tier: 'common', position })),
    rules: { scoring: { goal: 10 } }
  };
  const started = db.startWutDraftEvent({ eventId: event.id, environment, adminUserId: 1, now: new Date('2026-07-04T18:03:00Z') });
  environment.cards[0].tier = 'common';
  assert.equal(started.environment_snapshot.cards[0].tier, 'rare');
  assert.throws(() => db.startWutDraftEvent({ eventId: event.id, environment, adminUserId: 1 }), /only start after signup closes|already has/);

  db.pauseWutDraftEvent({ eventId: event.id, adminUserId: 1, reason: 'Recovery pause' });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'cancelled', adminUserId: 1, reason: 'Admin recovery test', now: new Date('2026-07-04T18:04:00Z') });
  assert.equal(db.getWutMembershipState(1).wutCoins, startingCoins + 1000);
  const cancelled = db.getWutDraftEventLobby({ eventId: event.id })[0];
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.entrants.filter(row => row.status === 'cancelled').length, 1);
  assert.ok(cancelled.logs.some(row => row.type === 'pause_overridden_for_cancellation'));
  assert.ok(cancelled.logs.some(row => row.type === 'event_cancelled_refunds'));
});

test('admin Draft Event match recovery can void or force a forfeit deterministically', () => {
  const voided = { id: 10, status: 'active', player_ids: [7, 8], winner_user_id: null };
  const voidResult = draftEvents.resolveWutDraftEventMatchRecord(voided, { action: 'void', adminUserId: 1, reason: 'Soft lock', now: new Date('2026-07-04T20:00:00Z') });
  assert.equal(voided.status, 'voided');
  assert.equal(voided.void_reason, 'Soft lock');
  assert.equal(voidResult.type, 'match_voided');

  const forfeited = { id: 11, status: 'scoring', player_ids: [7, 8] };
  const forfeitResult = draftEvents.resolveWutDraftEventMatchRecord(forfeited, { action: 'forfeit', forfeitingUserId: 8, adminUserId: 1, reason: 'Disconnected', now: new Date('2026-07-04T20:01:00Z') });
  assert.equal(forfeited.status, 'completed');
  assert.equal(forfeited.winner_user_id, 7);
  assert.equal(forfeited.forfeit_user_id, 8);
  assert.deepEqual(forfeited.scores, { 7: 1, 8: 0 });
  assert.equal(forfeitResult.type, 'match_forfeit_forced');
  assert.throws(() => draftEvents.resolveWutDraftEventMatchRecord({ id: 12, status: 'completed', player_ids: [7, 8] }, { action: 'void' }), /Only unresolved/);
});

test.skip('shared Safety Bench voting distributes identical temporary cards without touching permanent collections', () => {
  const voter = db.addUser({ username: 'draft-bench-voter', password: 'test-password', displayName: 'Draft Bench Voter' });
  db.joinWut(voter.id);
  db.openWutStarterPack({
    userId: voter.id,
    items: ['F', 'F', 'D', 'D', 'G'].map((position, index) => ({
      itemType: 'player', rolledTier: 'common', position,
      cardIdentity: `S3|BENCHUSER|${index}`, catalogKey: `S3|BENCHUSER|${index}`,
      edition: 'S3', divisionId: 'BENCHUSER', playerKey: String(index)
    }))
  });
  const permanentBefore = db.getCardsOwnedState(1).cards.length + db.getCardsOwnedState(voter.id).cards.length;
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name: 'Bench Vote Test', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 4, allowOddEntrants: true, visibility: 'public' },
      safetyBench: { mode: 'shared_vote', votingSeconds: 60, rarityMin: 'common', rarityMax: 'common' },
      boosters: { rarityOdds: { players: { common: 100 }, boosts: { common: 100 }, trinkets: { common: 100 } } }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: voter.id });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const cards = [
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|POOL|F${index}`, displayName: `Forward ${index}`, edition: 'S3', position: 'F', tier: 'common', stars: 1 })),
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|POOL|D${index}`, displayName: `Defense ${index}`, edition: 'S3', position: 'D', tier: 'common', stars: 1 })),
    ...Array.from({ length: 2 }, (_, index) => ({ cardIdentity: `S3|POOL|G${index}`, displayName: `Goalie ${index}`, edition: 'S3', position: 'G', tier: 'common', stars: 1 }))
  ];
  db.startWutDraftEvent({ eventId: event.id, environment: { cards, rules: {} }, adminUserId: 1 });
  const voting = db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, random: () => 0.999 });
  assert.equal(voting.phase, 'bench_vote');
  assert.equal(voting.bench.candidates.length, 10);
  assert.equal(db.getPendingWutDraftActionEventIds(1).includes(event.id), true, 'an uncast Safety Bench vote requires attention');
  const byPosition = position => voting.bench.candidates.filter(candidate => candidate.position === position).map(candidate => candidate.card.cardIdentity);
  const selections = { F: byPosition('F').slice(0, 2), D: byPosition('D').slice(0, 2), G: byPosition('G').slice(0, 1) };
  db.voteWutDraftSafetyBench({ eventId: event.id, userId: 1, selections });
  assert.equal(db.getPendingWutDraftActionEventIds(1).includes(event.id), false, 'casting the Safety Bench vote clears the alert');
  db.voteWutDraftSafetyBench({ eventId: event.id, userId: voter.id, selections });
  assert.throws(() => db.voteWutDraftSafetyBench({ eventId: event.id, userId: 1, selections: { ...selections, F: selections.F.slice(0, 1) } }), /exactly 2/);
  const completed = db.finishWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, random: () => 0.5 });
  assert.equal(completed.phase, 'draft');
  assert.equal(completed.bench.winners.length, 5);
  const firstInventory = completed.inventories['1'];
  const secondInventory = completed.inventories[String(voter.id)];
  assert.equal(firstInventory.cards.length, 5);
  assert.deepEqual(firstInventory.cards.map(card => card.card_identity), secondInventory.cards.map(card => card.card_identity));
  assert.notDeepEqual(firstInventory.cards.map(card => card.id), secondInventory.cards.map(card => card.id));
  assert.equal(db.getCardsOwnedState(1).cards.length + db.getCardsOwnedState(voter.id).cards.length, permanentBefore);
  const retried = db.finishWutDraftSafetyBench({ eventId: event.id, adminUserId: 1 });
  assert.equal(retried.inventories['1'].cards.length, 5, 'retrying completion cannot duplicate temporary cards');
});

test.skip('expired Safety Bench voting resolves from its persisted deadline after a clock restart', () => {
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name: 'Bench Deadline Test', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 4, allowOddEntrants: true, allowManualStartBelowMinimum: true, visibility: 'public' },
      safetyBench: { mode: 'shared_vote', votingSeconds: 5, rarityMin: 'common', rarityMax: 'common' },
      boosters: { rarityOdds: { players: { common: 100 }, boosts: { common: 100 }, trinkets: { common: 100 } } }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const cards = [
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|CLOCK|F${index}`, displayName: `Clock F${index}`, edition: 'S3', position: 'F', tier: 'common' })),
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|CLOCK|D${index}`, displayName: `Clock D${index}`, edition: 'S3', position: 'D', tier: 'common' })),
    ...Array.from({ length: 2 }, (_, index) => ({ cardIdentity: `S3|CLOCK|G${index}`, displayName: `Clock G${index}`, edition: 'S3', position: 'G', tier: 'common' }))
  ];
  const startedAt = new Date('2026-07-04T21:00:00Z');
  db.startWutDraftEvent({ eventId: event.id, environment: { cards, rules: {} }, adminUserId: 1, now: startedAt });
  db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, now: startedAt, random: () => 0.5 });
  assert.equal(db.processWutDraftEvents(new Date('2026-07-04T21:00:04Z')).includes(event.id), false);
  assert.equal(db.processWutDraftEvents(new Date('2026-07-04T21:00:06Z')).includes(event.id), true);
  const resolved = db.getWutDraftEventLobby({ eventId: event.id })[0];
  assert.equal(resolved.phase, 'draft');
  assert.equal(resolved.inventories['1'].cards.length, 5);
  assert.equal(db.processWutDraftEvents(new Date('2026-07-04T21:00:10Z')).includes(event.id), false);
});

test('visual booster draft keeps every seat composition-identical while picks pass and inventories stay event-scoped', () => {
  const opponent = db.addUser({ username: 'compact-draft-user', password: 'test-password', displayName: 'Compact Draft User' });
  db.joinWut(opponent.id);
  db.openWutStarterPack({
    userId: opponent.id,
    items: ['F', 'F', 'D', 'D', 'G'].map((position, index) => ({
      itemType: 'player', rolledTier: 'common', position,
      cardIdentity: `S3|COMPACTUSER|${index}`, catalogKey: `S3|COMPACTUSER|${index}`,
      edition: 'S3', divisionId: 'COMPACTUSER', playerKey: String(index)
    }))
  });
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name: 'Compact Visual Draft', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 2, allowOddEntrants: true, visibility: 'public' },
      safetyBench: { mode: 'disabled' },
      boosters: {
        countPerPlayer: 1, contents: { players: 1, boosts: 1, trinkets: 1 },
        rarityOdds: { players: { common: 100 }, boosts: { rare: 100 }, trinkets: { uncommon: 100 } },
        pool: { allowDuplicateInBooster: false, allowDuplicateInEvent: false }
      },
      draft: { pickSeconds: 30, passDirections: ['left'], autopick: { enabled: true, priority: ['rarity', 'player', 'trinket', 'boost', 'random'] } },
      deckbuilding: { seconds: 30, activeMinimum: 1, activeMaximum: 1 }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: opponent.id });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const cards = [0, 1].map(index => ({ cardIdentity: `S3|COMPACT|P${index}`, displayName: `Compact Player ${index}`, edition: 'S3', position: index ? 'D' : 'F', tier: 'common' }));
  const config = db.getCardsConfig();
  db.startWutDraftEvent({ eventId: event.id, environment: { cards, rules: { boostEffects: config.boostEffects, trinketEffects: config.wut.trinketEffects, rarityCosts: config.wut.rarityCosts, trinketPowerValues: config.wut.trinketPowerValues } }, adminUserId: 1 });
  const drafting = db.beginWutDraftEvent({ eventId: event.id, adminUserId: 1, random: () => 0.25 });
  assert.equal(drafting.phase, 'draft');
  assert.equal(db.getPendingWutDraftActionEventIds(1).includes(event.id), true, 'a pending booster pick requires attention');
  assert.equal(db.getPendingWutDraftActionEventIds(opponent.id).includes(event.id), true);
  const packs = drafting.draft.boosters;
  assert.equal(packs.length, 2);
  const composition = pack => pack.items.map(item => `${item.item_type}:${item.rarity}`);
  assert.deepEqual(composition(packs[0]), composition(packs[1]));
  assert.notEqual(packs[0].items.find(item => item.item_type === 'player').card_identity, packs[1].items.find(item => item.item_type === 'player').card_identity);

  const firstPack = packs.find(pack => Number(pack.current_owner_user_id) === 1);
  db.pickWutDraftItem({ eventId: event.id, userId: 1, itemId: firstPack.items[0].id, now: new Date('2026-07-04T22:00:00Z') });
  assert.equal(db.getPendingWutDraftActionEventIds(1).includes(event.id), false, 'locking the pick clears attention while packs wait to pass');
  assert.equal(db.getPendingWutDraftActionEventIds(opponent.id).includes(event.id), true);
  const forced = db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, now: new Date('2026-07-04T22:00:01Z'), random: () => 0.1 });
  assert.equal(forced.picks.length, 1);
  assert.equal(forced.event.draft.current_pick, 2);
  assert.ok(forced.event.draft.pass_log.every(row => row.direction === 'left'));
  while (db.getWutDraftEventLobby({ eventId: event.id })[0].phase === 'draft') {
    db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, now: new Date('2026-07-04T22:00:02Z'), random: () => 0.1 });
  }
  const completed = db.getWutDraftEventLobby({ eventId: event.id })[0];
  assert.equal(completed.phase, 'deckbuilding');
  assert.equal(db.getPendingWutDraftActionEventIds(1).includes(event.id), true, 'an unsubmitted Event Deck requires attention');
  assert.equal(db.getPendingWutDraftActionEventIds(opponent.id).includes(event.id), true);
  assert.equal(completed.draft.picks.length, 6);
  for (const userId of [1, opponent.id]) {
    const inventory = completed.inventories[String(userId)];
    assert.equal(inventory.cards.length + inventory.boosts.length + inventory.trinkets.length, 3);
  }
  assert.equal(db.processWutDraftEvents(new Date('2026-07-04T22:00:33Z')).includes(event.id), true);
  const tournament = db.getWutDraftEventLobby({ eventId: event.id })[0];
  assert.equal(tournament.phase, 'tournament');
  assert.ok([1, opponent.id].every(userId => tournament.decks[String(userId)]?.automatic));
});

test('Event Decks use only drafted cards, snapshot temporary trinkets, and lock without touching permanent inventory', () => {
  const permanentBefore = db.getCardsOwnedState(1).cards.length;
  const opponent = db.addUser({ username: 'event-deck-user', password: 'test-password', displayName: 'Event Deck User' });
  db.joinWut(opponent.id);
  db.openWutStarterPack({ userId: opponent.id, items: ['F', 'F', 'D', 'D', 'G'].map((position, index) => ({
    itemType: 'player', rolledTier: 'common', position, cardIdentity: `S3|EVENTDECKUSER|${index}`,
    catalogKey: `S3|EVENTDECKUSER|${index}`, edition: 'S3', divisionId: 'EVENTDECKUSER', playerKey: String(index)
  })) });
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name: 'Event Deck Test', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 2, allowOddEntrants: true, allowManualStartBelowMinimum: true, visibility: 'private' },
      safetyBench: { mode: 'disabled' },
      boosters: {
        countPerPlayer: 1, contents: { players: 5, boosts: 1, trinkets: 1 },
        rarityOdds: { players: { common: 100 }, boosts: { common: 100 }, trinkets: { common: 100 } },
        pool: { allowDuplicateInBooster: false, allowDuplicateInEvent: false }
      },
      draft: { pickSeconds: 30, autopick: { enabled: true, priority: ['player', 'trinket', 'boost', 'rarity', 'random'] } },
      deckbuilding: { seconds: 300, activeMinimum: 5, activeMaximum: 5, lockDeckForTournament: true }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: opponent.id });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const playerPool = Array.from({ length: 10 }, (_, index) => ({
    cardIdentity: `S3|EVENTDECK|${index}`, displayName: `Event Player ${index}`, edition: 'S3',
    position: index % 5 < 2 ? 'F' : index % 5 < 4 ? 'D' : 'G', tier: 'common', stars: 1
  }));
  const config = db.getCardsConfig();
  db.startWutDraftEvent({ eventId: event.id, environment: { cards: playerPool, rules: { boostEffects: config.boostEffects, trinketEffects: config.wut.trinketEffects, rarityCosts: config.wut.rarityCosts, trinketPowerValues: config.wut.trinketPowerValues } }, adminUserId: 1 });
  db.beginWutDraftEvent({ eventId: event.id, adminUserId: 1, random: () => 0.1 });
  while (db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase === 'draft') {
    db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, random: () => 0.1 });
  }
  let building = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  const inventory = building.inventories['1'];
  assert.equal(inventory.cards.length, 5);
  assert.equal(inventory.trinkets.length, 1);
  const skater = inventory.cards.find(card => card.player_snapshot.position !== 'G');
  assert.throws(() => db.saveWutDraftEventDeck({ eventId: event.id, userId: 1, activeCardIds: inventory.cards.slice(0, 4).map(card => card.id) }), /exactly 5/);
  const saved = db.saveWutDraftEventDeck({
    eventId: event.id,
    userId: 1,
    activeCardIds: inventory.cards.map(card => card.id),
    trinketAssignmentIds: { [skater.id]: inventory.trinkets[0].id }
  });
  assert.equal(saved.event.phase, 'deckbuilding', 'the first submitted Event Deck waits for the other entrant');
  assert.equal(saved.deck.active_snapshots.find(card => card.event_item_id === skater.id).trinket.id, inventory.trinkets[0].id);
  assert.equal(saved.deck.active_snapshots.find(card => card.event_item_id === skater.id).power, 1);
  db.saveWutDraftEventDeck({ eventId: event.id, userId: 1, activeCardIds: inventory.cards.map(card => card.id) });
  let resaved = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.ok(resaved.decks['1'], 'editing a trinket must preserve an already-submitted Event Deck');
  assert.equal(resaved.decks['1'].active_snapshots.find(card => card.event_item_id === skater.id).trinket, null);
  db.saveWutDraftEventDeck({
    eventId: event.id,
    userId: 1,
    activeCardIds: inventory.cards.map(card => card.id),
    trinketAssignmentIds: { [skater.id]: inventory.trinkets[0].id }
  });
  resaved = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.equal(resaved.decks['1'].active_snapshots.find(card => card.event_item_id === skater.id).trinket.id, inventory.trinkets[0].id, 'an active Event Deck card receives the temporary trinket snapshot');
  const opponentInventory = resaved.inventories[String(opponent.id)];
  db.saveWutDraftEventDeck({ eventId: event.id, userId: opponent.id, activeCardIds: opponentInventory.cards.map(card => card.id) });
  assert.throws(() => db.saveWutDraftEventDeck({ eventId: event.id, userId: 1, activeCardIds: inventory.cards.map(card => card.id) }), /not open/);
  assert.equal(db.getCardsOwnedState(1).cards.length, permanentBefore);
});

test('Draft Event tournament reuses real lineup turns, scores temporary cards, and produces standings', () => {
  const opponent = db.addUser({ username: 'event-match-user', password: 'test-password', displayName: 'Event Match User' });
  db.joinWut(opponent.id);
  db.openWutStarterPack({ userId: opponent.id, items: ['F', 'F', 'D', 'D', 'G'].map((position, index) => ({ itemType: 'player', rolledTier: 'common', position, cardIdentity: `S3|EVENTMATCHUSER|${index}`, catalogKey: `S3|EVENTMATCHUSER|${index}`, edition: 'S3', divisionId: 'EVENTMATCHUSER', playerKey: String(index) })) });
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name: 'Two Player Tournament', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 2, allowOddEntrants: true, visibility: 'private' },
      safetyBench: { mode: 'disabled' },
      boosters: { countPerPlayer: 1, contents: { players: 1, boosts: 0, trinkets: 0 }, rarityOdds: { players: { common: 100 } }, pool: { allowDuplicateInBooster: false, allowDuplicateInEvent: true } },
      draft: { pickSeconds: 30, autopick: { enabled: true, priority: ['player', 'rarity', 'random'] } },
      deckbuilding: { seconds: 300, activeMinimum: 1, activeMaximum: 1 },
      tournament: { format: 'round_robin', automaticNextRound: true, betweenRoundSeconds: 0, roundRobin: { meetings: 1, byeCountsAsWin: true } },
      match: { turnSeconds: 300, openingTimeout: 'forfeit', laterTimeout: 'forfeit', boostLoadCap: 5, boostsMode: 'tournament_consumable' },
      prizes: { tiers: [
        { key: 'champion', label: 'Champion', places: [1], rewards: [{ type: 'wut_coins', amount: 123, quantity: 1 }, { type: 'specific_trinket', family: 'safety_net', rarity: 'rare', quantity: 1 }] },
        { key: 'players', label: 'All Players', participant: true, rewards: [{ type: 'player_pack', packType: 'standard', quantity: 1 }, { type: 'random_trinket', rarity: 'common', quantity: 1 }] }
      ] }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: opponent.id });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const pool = [
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|TOURNEY|F${index}`, displayName: `Tourney F${index}`, edition: 'S3', position: 'F', tier: 'common' })),
    ...Array.from({ length: 4 }, (_, index) => ({ cardIdentity: `S3|TOURNEY|D${index}`, displayName: `Tourney D${index}`, edition: 'S3', position: 'D', tier: 'common' })),
    ...Array.from({ length: 2 }, (_, index) => ({ cardIdentity: `S3|TOURNEY|G${index}`, displayName: `Tourney G${index}`, edition: 'S3', position: 'G', tier: 'common' }))
  ];
  const config = db.getCardsConfig();
  db.startWutDraftEvent({ eventId: event.id, environment: { cards: pool, rules: { scoring: config.scoring, boostEffects: config.boostEffects, trinketEffects: config.wut.trinketEffects, rarityCosts: config.wut.rarityCosts, trinketPowerValues: config.wut.trinketPowerValues, slotPowerAllowance: config.wut.slotPowerAllowance } }, adminUserId: 1 });
  db.beginWutDraftEvent({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  while (db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase === 'draft') db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  let state = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  for (const userId of [1, opponent.id]) {
    const inventory = state.inventories[String(userId)];
    const drafted = inventory.cards[0];
    db.saveWutDraftEventDeck({ eventId: event.id, userId, activeCardIds: [drafted.id] });
  }
  state = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.equal(state.phase, 'tournament');
  assert.equal(state.tournament.matches.length, 1);
  const matchId = state.tournament.matches[0].id;
  const openingView = db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 });
  const openingUserId = openingView.match.current_player_id;
  const waitingUserId = openingView.match.player_ids.map(Number).find(userId => userId !== Number(openingUserId));
  assert.equal(db.getPendingWutDraftActionEventIds(openingUserId).includes(event.id), true, 'the active tournament player receives attention');
  assert.equal(db.getPendingWutDraftActionEventIds(waitingUserId).includes(event.id), false, 'the waiting tournament player does not');
  const openingSnapshot = openingView.match.deck_snapshots[String(openingUserId)];
  const openingCard = [...openingSnapshot.active, ...(openingSnapshot.bench || [])].find(card => card.position === 'F');
  db.commitWutDraftEventTurn({ eventId: event.id, matchId, userId: openingUserId, placements: [{ slot: 'F1', cardId: openingCard.card_id }] });
  assert.equal(db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 }).match.placements.length, 1);
  assert.equal(db.getPendingWutDraftActionEventIds(openingUserId).includes(event.id), false);
  assert.equal(db.getPendingWutDraftActionEventIds(waitingUserId).includes(event.id), true, 'attention follows the tournament turn');
  const replayed = db.resetCurrentWutDraftEventRound({ eventId: event.id, adminUserId: 1, reason: 'Regression recovery' });
  assert.equal(replayed.tournament.matches[0].placements.length, 0, 'round reset clears committed lineups');
  assert.equal(replayed.tournament.matches[0].turn_index, 0, 'round reset restores the opening turn');
  assert.equal(replayed.tournament.matches[0].status, 'active');
  assert.ok(replayed.logs.some(row => row.type === 'tournament_round_reset'));
  while (true) {
    const view = db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 });
    if (view.match.status !== 'active') break;
    const userId = view.match.current_player_id; const required = view.match.cards_required_this_turn;
    const deckSnapshot = view.match.deck_snapshots[String(userId)];
    const snapshots = [...deckSnapshot.active, ...(deckSnapshot.bench || [])];
    const occupied = new Set(view.match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => row.slot));
    const used = new Set(view.match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id)));
    const usedIdentities = new Set(view.match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => row.card_snapshot?.card_identity).filter(Boolean));
    const choices = [];
    for (const slot of ['F1', 'F2', 'D1', 'D2', 'G'].filter(slot => !occupied.has(slot))) {
      const position = slot === 'G' ? 'G' : slot[0];
      const chosenIdentities = new Set(choices.map(choice => snapshots.find(item => Number(item.card_id) === Number(choice.cardId))?.card_identity).filter(Boolean));
      const card = snapshots.find(item => item.position === position && !used.has(Number(item.card_id)) && !usedIdentities.has(item.card_identity) && !choices.some(choice => Number(choice.cardId) === Number(item.card_id)) && !chosenIdentities.has(item.card_identity));
      if (card) choices.push({ slot, cardId: card.card_id });
      if (choices.length === required) break;
    }
    db.commitWutDraftEventTurn({ eventId: event.id, matchId, userId, placements: choices });
  }
  let match = db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 }).match;
  assert.equal(match.status, 'scoring');
  db.completeArenaMatch(match.arena_match_key, match.placements.map(row => ({ ...row, fp: Number(row.user_id) === 1 ? 10 : 5 })));
  state = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.equal(state.phase, 'complete');
  assert.equal(state.tournament.standings[0].user_id, 1);
  assert.equal(state.tournament.standings[0].wins, 1);
  match = db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 }).match;
  assert.equal(match.status, 'ready');
  db.completeWutDraftEventReveal({ eventId: event.id, matchId, userId: 1 });
  db.completeWutDraftEventReveal({ eventId: event.id, matchId, userId: opponent.id });
  assert.equal(db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 }).match.status, 'completed');
  const winnerCoinsBefore = db.getWutMembershipState(1).wutCoins;
  const opponentPendingBefore = db.getPendingCardsPack(opponent.id);
  assert.equal(opponentPendingBefore.source, 'starter_bonus');
  const prizePack = packType => [
    ...Array.from({ length: 3 }, (_, index) => ({ itemType: 'player', rolledTier: 'common', position: index ? 'D' : 'F', cardIdentity: `S3|PRIZE|${packType}|${index}`, catalogKey: `S3|PRIZE|${packType}|${index}`, edition: 'S3', divisionId: 'PRIZE', playerKey: `${packType}-${index}` })),
    { itemType: 'boost', boostType: 'goal', rarity: 'common', effect: { per: 1, bonus: 1 } },
    { itemType: 'boost', boostType: 'grit', rarity: 'common', effect: { per: 1, bonus: 1 } }
  ];
  const awarded = db.awardWutDraftEventPrizes({ eventId: event.id, generatePack: prizePack, random: () => 0.1 });
  assert.equal(awarded.alreadyAwarded, false);
  assert.equal(awarded.awards.length, 6);
  assert.equal(db.getWutMembershipState(1).wutCoins, winnerCoinsBefore + 123);
  const finished = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.equal(finished.phase, 'prizes_awarded');
  assert.deepEqual(finished.inventories, {});
  assert.equal(Object.keys(finished.archived_inventories).length, 2);
  assert.ok(finished.cleanup.temporary_items_removed_at);
  assert.ok(db.getWutSystemsState(1).trinkets.some(item => item.source === 'draft_event_prize' && item.family === 'safety_net' && item.rarity === 'rare'));
  const retry = db.awardWutDraftEventPrizes({ eventId: event.id, generatePack: () => { throw new Error('must not reroll'); } });
  assert.equal(retry.alreadyAwarded, true);
  assert.equal(db.getWutMembershipState(1).wutCoins, winnerCoinsBefore + 123);
  db.claimCardsPack(opponent.id, opponentPendingBefore.id);
  const promotedPrize = db.getPendingCardsPack(opponent.id);
  assert.equal(promotedPrize.source, 'draft_event_prize');
  assert.equal(promotedPrize.draft_event_id, event.id);
  assert.equal(db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 }).match.status, 'completed', 'match replays survive temporary-inventory cleanup');
});

test('all Draft Event tournament formats advance cleanly with odd-player byes and no Swiss rematches', () => {
  const cases = [
    { name: 'Audit Round Robin', entrants: 3, tournament: { format: 'round_robin', roundRobin: { meetings: 1, byeCountsAsWin: true } }, expectedRounds: 3 },
    { name: 'Audit Swiss', entrants: 4, tournament: { format: 'swiss', swiss: { rounds: 3, avoidRematches: true, byeCountsAsWin: true } }, expectedRounds: 3 },
    { name: 'Audit Elimination', entrants: 14, tournament: { format: 'single_elimination', elimination: { seeding: 'draft_order', thirdPlaceMatch: true, consolationMatch: true } }, expectedRounds: 4 },
    { name: 'Audit Top Cut', entrants: 4, tournament: { format: 'swiss_top_cut', topCut: { swissRounds: 1, advancing: 2, seeding: 'standings' } }, expectedRounds: 2 }
  ];
  for (const fixture of cases) {
    const { eventId } = createDraftTournamentFixture({ name: fixture.name, entrantCount: fixture.entrants, tournament: fixture.tournament });
    let guard = 0;
    while (db.getWutDraftEventLobby({ eventId, includePrivate: true })[0].phase === 'tournament' && guard++ < 30) {
      const event = db.getWutDraftEventLobby({ eventId, includePrivate: true })[0];
      const active = event.tournament.matches.filter(match => match.status === 'active');
      assert.ok(active.length, `${fixture.name} should always expose an active match while its tournament is live`);
      for (const match of active) db.resolveWutDraftEventMatch({ eventId, matchId: match.id, action: 'forfeit', forfeitingUserId: match.player_ids[1], adminUserId: 1 });
    }
    const completed = db.getWutDraftEventLobby({ eventId, includePrivate: true })[0];
    assert.equal(completed.phase, 'complete', `${fixture.name} should complete`);
    assert.equal(completed.tournament.rounds.length, fixture.expectedRounds);
    if (fixture.tournament.format === 'round_robin') {
      assert.ok(completed.tournament.rounds.every(round => round.bye_user_ids.length === 1));
      assert.equal(new Set(completed.tournament.matches.map(match => match.player_ids.map(Number).sort((a, b) => a - b).join(':'))).size, 3);
    }
    if (fixture.tournament.format === 'swiss') {
      const pairKeys = completed.tournament.matches.map(match => match.player_ids.map(Number).sort((a, b) => a - b).join(':'));
      assert.equal(new Set(pairKeys).size, pairKeys.length, 'Swiss should avoid rematches when a legal alternative exists');
    }
    if (fixture.tournament.format === 'single_elimination') {
      assert.equal(completed.tournament.rounds[0].match_ids.length, 7, '14 entrants should all play in round one');
      assert.equal(completed.tournament.rounds[0].bye_user_ids.length, 0, 'round one should not pad to a 16-player bracket');
      assert.equal(completed.tournament.rounds[1].match_ids.length, 3);
      assert.equal(completed.tournament.rounds[1].bye_user_ids.length, 1, 'the seven round-one winners should produce exactly one performance bye');
      assert.equal(completed.tournament.rounds.reduce((sum, round) => sum + round.bye_user_ids.length, 0), 1, 'the tournament should minimize total byes');
      const finalMatches = completed.tournament.rounds.at(-1).match_ids.map(id => completed.tournament.matches.find(match => Number(match.id) === Number(id)));
      assert.deepEqual(finalMatches.map(match => match.bracket_role).sort(), ['championship', 'consolation', 'third_place']);
    }
    if (fixture.tournament.format === 'swiss_top_cut') assert.deepEqual(completed.tournament.rounds.map(round => round.stage), ['swiss', 'elimination']);
  }
});

test('sequential Draft Event matches, timeout forfeits, and paused timers recover deterministically', () => {
  const sequential = createDraftTournamentFixture({ name: 'Audit Sequential', entrantCount: 4, tournament: { format: 'round_robin', roundRobin: { meetings: 1 } }, match: { simultaneousMatches: false } });
  let event = db.getWutDraftEventLobby({ eventId: sequential.eventId, includePrivate: true })[0];
  assert.equal(event.tournament.matches.filter(match => match.status === 'active').length, 1);
  assert.equal(event.tournament.matches.filter(match => match.status === 'pending').length, 1);
  const first = event.tournament.matches.find(match => match.status === 'active');
  db.resolveWutDraftEventMatch({ eventId: sequential.eventId, matchId: first.id, action: 'forfeit', forfeitingUserId: first.player_ids[1], adminUserId: 1 });
  event = db.getWutDraftEventLobby({ eventId: sequential.eventId, includePrivate: true })[0];
  assert.equal(event.tournament.matches.filter(match => match.status === 'active').length, 1, 'the next sequential match should activate immediately');

  const timed = createDraftTournamentFixture({ name: 'Audit Timeout', entrantCount: 2, tournament: { format: 'round_robin', roundRobin: { meetings: 1 } }, match: { openingTimeout: 'forfeit' } });
  event = db.getWutDraftEventLobby({ eventId: timed.eventId, includePrivate: true })[0];
  const timedMatch = event.tournament.matches[0];
  const originalDeadline = new Date(timedMatch.turn_deadline);
  const pausedAt = new Date(originalDeadline.getTime() - 120000);
  db.pauseWutDraftEvent({ eventId: timed.eventId, adminUserId: 1, reason: 'Timer audit', now: pausedAt });
  db.resumeWutDraftEvent({ eventId: timed.eventId, adminUserId: 1, now: new Date(pausedAt.getTime() + 60000) });
  event = db.getWutDraftEventLobby({ eventId: timed.eventId, includePrivate: true })[0];
  const shiftedDeadline = new Date(event.tournament.matches[0].turn_deadline);
  assert.equal(shiftedDeadline.getTime() - originalDeadline.getTime(), 60000);
  db.pauseWutDraftEvent({ eventId: timed.eventId, adminUserId: 1, reason: 'Long delay', now: shiftedDeadline });
  const longerTimer = db.updateWutDraftTournamentTurnSeconds({ eventId: timed.eventId, adminUserId: 1, seconds: 86400, now: new Date(shiftedDeadline.getTime() + 30000) });
  assert.equal(longerTimer.config.match.turnSeconds, 86400);
  assert.equal(new Date(longerTimer.tournament.matches[0].turn_deadline).getTime(), shiftedDeadline.getTime() + 86400000);
  const resumeAt = new Date(shiftedDeadline.getTime() + 120000);
  db.resumeWutDraftEvent({ eventId: timed.eventId, adminUserId: 1, now: resumeAt });
  event = db.getWutDraftEventLobby({ eventId: timed.eventId, includePrivate: true })[0];
  const longDeadline = new Date(event.tournament.matches[0].turn_deadline);
  assert.equal(longDeadline.getTime(), resumeAt.getTime() + 86400000);
  db.processWutDraftEvents(new Date(longDeadline.getTime() - 1));
  event = db.getWutDraftEventLobby({ eventId: timed.eventId, includePrivate: true })[0];
  assert.equal(event.phase, 'tournament');
  db.processWutDraftEvents(new Date(shiftedDeadline.getTime() + 1));
  event = db.getWutDraftEventLobby({ eventId: timed.eventId, includePrivate: true })[0];
  assert.equal(event.phase, 'tournament');
  db.processWutDraftEvents(new Date(longDeadline.getTime() + 1));
  event = db.getWutDraftEventLobby({ eventId: timed.eventId, includePrivate: true })[0];
  assert.equal(event.phase, 'complete');
  assert.equal(event.tournament.matches[0].forfeit_user_id, timedMatch.first_player_id);
});

test('scheduled Draft Events open, close, and support a permission-safe automatic start', () => {
  const user = db.addUser({ username: `scheduled-draft-${Date.now()}`, password: 'test-password', displayName: 'Scheduled Draft Player' });
  db.joinWut(user.id);
  db.openWutStarterPack({ userId: user.id, items: ['F', 'F', 'D', 'D', 'G'].map((position, index) => ({ itemType: 'player', rolledTier: 'common', position, cardIdentity: `S3|SCHEDULED|${index}`, catalogKey: `S3|SCHEDULED|${index}`, edition: 'S3', divisionId: 'SCHEDULED', playerKey: String(index) })) });
  const opens = new Date('2026-08-01T18:00:00Z'); const closes = new Date('2026-08-01T18:05:00Z'); const starts = new Date('2026-08-01T18:10:00Z');
  const event = db.createWutDraftEvent({ adminUserId: 1, config: {
    basic: { name: 'Scheduled Lifecycle Audit', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 2, allowOddEntrants: true, automaticStart: true, visibility: 'private' },
    signup: { automaticClose: true }, safetyBench: { mode: 'disabled' },
    boosters: { countPerPlayer: 1, contents: { players: 1, boosts: 0, trinkets: 0 }, rarityOdds: { players: { common: 100 } }, pool: { allowDuplicateInBooster: false, allowDuplicateInEvent: true } },
    scheduling: { signupOpensAt: opens.toISOString(), signupClosesAt: closes.toISOString(), startsAt: starts.toISOString() }
  } });
  assert.throws(() => db.rescheduleWutDraftEvent({ eventId: event.id, adminUserId: 1, signupOpensAt: starts, signupClosesAt: opens, startsAt: closes }), /chronological/);
  db.rescheduleWutDraftEvent({ eventId: event.id, adminUserId: 1, signupOpensAt: opens, signupClosesAt: closes, startsAt: starts });
  assert.ok(db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].logs.some(row => row.type === 'event_rescheduled'));
  assert.equal(db.processWutDraftEvents(new Date(opens.getTime() - 1)).includes(event.id), false);
  db.processWutDraftEvents(opens);
  assert.equal(db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase, 'signup_open');
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 }); db.joinWutDraftEvent({ eventId: event.id, userId: user.id });
  db.processWutDraftEvents(closes);
  assert.equal(db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase, 'signup_closed');
  const pool = [0, 1].map(index => ({ cardIdentity: `S3|SCHEDULEPOOL|${index}`, displayName: `Schedule ${index}`, edition: 'S3', position: index ? 'D' : 'F', tier: 'common' }));
  db.startWutDraftEvent({ eventId: event.id, environment: { cards: pool, rules: {} }, adminUserId: null, system: true, now: starts });
  db.beginWutDraftEvent({ eventId: event.id, adminUserId: null, system: true, now: starts, random: () => 0.2 });
  assert.equal(db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase, 'draft');
});

test('unlocked Draft Event decks can sideboard only during a configured round intermission', () => {
  const fixture = createDraftTournamentFixture({
    name: 'Audit Sideboard', entrantCount: 2,
    tournament: { format: 'swiss', automaticNextRound: true, betweenRoundSeconds: 60, swiss: { rounds: 2, avoidRematches: false } },
    deckbuilding: { lockDeckForTournament: false, sideboardingBetweenRounds: true, lockTrinketAttachments: false, allowTrinketReassignment: true }
  });
  let event = db.getWutDraftEventLobby({ eventId: fixture.eventId, includePrivate: true })[0];
  assert.throws(() => db.saveWutDraftEventDeck({ eventId: fixture.eventId, userId: fixture.userIds[0], activeCardIds: event.decks[String(fixture.userIds[0])].active_card_ids }), /not open/);
  const match = event.tournament.matches.find(item => item.status === 'active');
  db.resolveWutDraftEventMatch({ eventId: fixture.eventId, matchId: match.id, action: 'forfeit', forfeitingUserId: match.player_ids[1], adminUserId: 1 });
  event = db.getWutDraftEventLobby({ eventId: fixture.eventId, includePrivate: true })[0];
  assert.ok(event.tournament.pending_round_plan);
  const ids = event.decks[String(fixture.userIds[0])].active_card_ids;
  db.saveWutDraftEventDeck({ eventId: fixture.eventId, userId: fixture.userIds[0], activeCardIds: ids });
  event = db.getWutDraftEventLobby({ eventId: fixture.eventId, includePrivate: true })[0];
  assert.ok(event.logs.some(row => row.type === 'event_deck_sideboarded'));
  db.processWutDraftEvents(new Date(new Date(event.tournament.next_round_at).getTime() + 1));
  event = db.getWutDraftEventLobby({ eventId: fixture.eventId, includePrivate: true })[0];
  assert.equal(event.tournament.round, 2);
  assert.throws(() => db.saveWutDraftEventDeck({ eventId: fixture.eventId, userId: fixture.userIds[0], activeCardIds: ids }), /not open/);
});

test('dropping a live Draft Event entrant forfeits the current match and removes future pairings', () => {
  const fixture = createDraftTournamentFixture({ name: 'Audit Drop', entrantCount: 3, tournament: { format: 'round_robin', roundRobin: { meetings: 1 } } });
  let event = db.getWutDraftEventLobby({ eventId: fixture.eventId, includePrivate: true })[0];
  const current = event.tournament.matches.find(match => match.status === 'active');
  const droppedId = current.player_ids[1];
  db.dropWutDraftEventEntrant({ eventId: fixture.eventId, userId: droppedId, adminUserId: 1, reason: 'Disconnected from event' });
  event = db.getWutDraftEventLobby({ eventId: fixture.eventId, includePrivate: true })[0];
  assert.equal(event.entrants.find(row => Number(row.user_id) === Number(droppedId)).status, 'dropped');
  assert.equal(event.tournament.matches.find(match => match.id === current.id).forfeit_user_id, droppedId);
  let guard = 0;
  while (event.phase === 'tournament' && guard++ < 10) {
    for (const match of event.tournament.matches.filter(item => item.status === 'active')) db.resolveWutDraftEventMatch({ eventId: fixture.eventId, matchId: match.id, action: 'forfeit', forfeitingUserId: match.player_ids[1], adminUserId: 1 });
    event = db.getWutDraftEventLobby({ eventId: fixture.eventId, includePrivate: true })[0];
  }
  assert.equal(event.phase, 'complete');
  assert.ok(event.tournament.matches.filter(match => match.id !== current.id).every(match => !match.player_ids.map(Number).includes(Number(droppedId))));
});

test('invalid booster rarity pools fail preflight without half-transitioning the event', () => {
  const event = db.createWutDraftEvent({
    adminUserId: 1,
    config: {
      basic: { name: 'Bad Pool Test', entryFee: { currency: 'free', amount: 0 }, minimumEntrants: 2, maximumEntrants: 2, allowOddEntrants: true, allowManualStartBelowMinimum: true, visibility: 'private' },
      safetyBench: { mode: 'disabled' },
      boosters: { countPerPlayer: 1, contents: { players: 1, boosts: 0, trinkets: 0 }, rarityOdds: { players: { legendary: 100 } } }
    }
  });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_open', adminUserId: 1 });
  db.joinWutDraftEvent({ eventId: event.id, userId: 1 });
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  db.startWutDraftEvent({ eventId: event.id, environment: { cards: [{ cardIdentity: 'S3|BAD|1', displayName: 'Only Common', edition: 'S3', position: 'F', tier: 'common' }], rules: {} }, adminUserId: 1 });
  assert.throws(() => db.beginWutDraftEvent({ eventId: event.id, adminUserId: 1, random: () => 0.5 }), /Not enough unique legendary/);
  const unchanged = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.equal(unchanged.phase, 'starting');
  assert.equal(unchanged.draft.boosters.length, 0);
});

test('trinket shops are personal and rotate at WUT midnight', () => {
  const now = new Date('2026-07-03T18:00:00.000Z');
  const other = db.addUser({ username: 'shop-owner', password: 'test-password', displayName: 'Shop Owner' });
  db.joinWut(other.id);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  db.openWutStarterPack({
    userId: other.id,
    items: positions.map((position, index) => ({
      itemType: 'player', rolledTier: 'common', position,
      cardIdentity: `S3|SHOP|player-${index}`, catalogKey: `S3|SHOP|player-${index}`,
      edition: 'S3', divisionId: 'SHOP', playerKey: `player-${index}`
    }))
  });
  const first = db.getWutSystemsState(1, now).shop;
  const second = db.getWutSystemsState(other.id, now).shop;
  assert.equal(first.user_id, 1);
  assert.equal(second.user_id, other.id);
  assert.notEqual(first.user_id, second.user_id);
  assert.equal(first.offers.length, 3);
  assert.equal(second.offers.length, 3);

  const dateKey = value => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: first.refresh_timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(value);
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  };
  const refreshAt = new Date(first.next_refresh_at);
  assert.equal(dateKey(new Date(refreshAt.getTime() - 1)), first.date_key);
  assert.notEqual(dateKey(refreshAt), first.date_key);

  const tomorrow = new Date(refreshAt.getTime() + 1000);
  const refreshedFirst = db.getWutSystemsState(1, tomorrow).shop;
  assert.notEqual(refreshedFirst.date_key, first.date_key);
  assert.equal(db.getWutSystemsState(other.id, now).shop.date_key, second.date_key);
});

test('completed missions award WUT Coins exactly once', () => {
  const userTwo = db.addUser({ username: 'mission-opponent', password: 'test-password', displayName: 'Mission Opponent' });
  db.joinWut(userTwo.id);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  const secondItems = positions.map((position, index) => ({
    itemType: 'player', rolledTier: 'common', position,
    cardIdentity: `S3|D2|mission-${index}`, catalogKey: `S3|D2|mission-${index}`,
    edition: 'S3', divisionId: 'D2', playerKey: `mission-${index}`
  }));
  db.openWutStarterPack({ userId: userTwo.id, items: secondItems });

  const catalogByIdentity = {};
  for (const userId of [1, userTwo.id]) {
    const membership = db.getWutMembershipState(userId);
    const owned = new Map(db.getCardsOwnedState(userId).cards.map(card => [Number(card.id), card]));
    membership.starterCardIds.forEach((id, index) => {
      const card = owned.get(Number(id));
      catalogByIdentity[card.card_identity] = { position: positions[index], tier: 'common', teamId: `M${userId}${index}`, teamName: `Mission ${userId}-${index}` };
    });
  }

  const firstDeck = saveConstructedTestDeck(1, 'MISSION-A', catalogByIdentity);
  const secondDeck = saveConstructedTestDeck(userTwo.id, 'MISSION-B', catalogByIdentity);
  db.enterArenaQueue(1, firstDeck.id, catalogByIdentity);
  db.enterArenaQueue(userTwo.id, secondDeck.id, catalogByIdentity);
  db.assignArenaMatchups();

  playConstructedSeriesToReady(1, catalogByIdentity, 1);
  const missions = db.getWutMissionsForUser(1);
  const firstWin = missions.daily.find(mission => mission.id === 'first_win');
  assert.equal(firstWin.complete, true);
  const before = db.getWutMembershipState(1).wutCoins;
  const claim = db.claimWutMission({ userId: 1, period: 'daily', missionId: 'first_win' });
  assert.equal(claim.wutCoins, before + 20);
  assert.throws(() => db.claimWutMission({ userId: 1, period: 'daily', missionId: 'first_win' }), /already claimed/i);
});

test('admin can inspect and safely void an active WUT match', () => {
  const first = db.addUser({ username: 'void-player-a', password: 'test-password', displayName: 'Void Player A' });
  const second = db.addUser({ username: 'void-player-b', password: 'test-password', displayName: 'Void Player B' });
  const positions = ['F', 'F', 'D', 'D', 'G'];
  const catalogByIdentity = {};
  for (const user of [first, second]) {
    db.joinWut(user.id);
    const items = positions.map((position, index) => ({
      itemType: 'player', rolledTier: 'common', position,
      cardIdentity: `S3|VOID-${user.id}|player-${index}`,
      catalogKey: `S3|VOID-${user.id}|player-${index}`,
      edition: 'S3', divisionId: `VOID-${user.id}`, playerKey: `player-${index}`
    }));
    db.openWutStarterPack({ userId: user.id, items });
    for (const item of items) catalogByIdentity[item.cardIdentity] = { position: item.position, tier: 'common', teamId: `VOID-${user.id}` };
    const deck = saveConstructedTestDeck(user.id, `VOID-${user.id}`, catalogByIdentity);
    db.enterArenaQueue(user.id, deck.id, catalogByIdentity);
  }
  db.assignArenaMatchups();
  let match = db.getArenaStateForUser(first.id).activeMatches[0];
  assert.ok(match);
  match = chooseFirstForConstructedMatch(match) || match;
  const currentUserId = Number(match.current_player_id);
  const currentDeck = match.deck_snapshots[String(currentUserId)].active;
  const forward = currentDeck.find(card => card.position === 'F');
  const boost = db.grantCardsTestItem({ userId: currentUserId, item: { itemType: 'boost', boostType: 'goal', rarity: 'common' } });
  db.commitArenaTurn({
    userId: currentUserId,
    matchId: match.id,
    placements: [{ slot: 'F1', cardId: forward.card_id, boostId: boost.id }],
    catalogByIdentity
  });
  assert.equal(db.getCardsOwnedState(currentUserId).boosts.find(item => item.id === boost.id).consumed, true);

  const beforeCoins = [first.id, second.id].map(userId => db.getWutMembershipState(userId).wutCoins);
  const adminView = db.getArenaAdminMatchState({ userId: first.id });
  assert.ok(adminView.activeMatches.some(item => item.id === match.id));
  assert.ok(adminView.activeMatches.find(item => item.id === match.id).players.some(player => player.displayName === 'Void Player A'));
  assert.throws(() => db.adminVoidArenaMatch({ matchId: match.id, adminUserId: first.id }), /admin access/i);

  const result = db.adminVoidArenaMatch({ matchId: match.id, adminUserId: 1, reason: 'Automated soft-lock recovery test' });
  assert.deepEqual(result.releasedBoostIds, [boost.id]);
  assert.equal(result.match.status, 'cancelled');
  assert.equal(result.match.cancel_note, 'Automated soft-lock recovery test');
  assert.equal(db.getCardsOwnedState(currentUserId).boosts.find(item => item.id === boost.id).consumed, false);
  assert.deepEqual([first.id, second.id].map(userId => db.getWutMembershipState(userId).wutCoins), beforeCoins);
  assert.ok(db.getArenaStateForUser(first.id).cancelledMatches.some(item => item.id === match.id && item.cancel_reason === 'admin_void'));
  assert.ok(db.getArenaAdminMatchState({ userId: first.id }).history.some(item => item.id === match.id));
  assert.equal(db.getArenaAdminMatchState().activeMatches.some(item => item.id === match.id), false);
  assert.throws(() => db.adminVoidArenaMatch({ matchId: match.id, adminUserId: 1 }), /only active or scoring/i);
});

test('sportsbook coverage counts betting options rather than their outcomes and completes only at lock', () => {
  const week = db.getAdminSettings().currentWeek;
  const missedUser = db.addUser({ username: 'missed-weekly', password: 'test-password', displayName: 'Missed Weekly' });
  db.joinWut(missedUser.id);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  db.openWutStarterPack({ userId: missedUser.id, items: positions.map((position, index) => ({
    itemType: 'player', rolledTier: 'common', position,
    cardIdentity: `S3|MISSED|player-${index}`, catalogKey: `S3|MISSED|player-${index}`,
    edition: 'S3', divisionId: 'MISSED', playerKey: `player-${index}`
  })) });
  db.saveSeriesOddsForWeek({
    week,
    seriesKey: 'D1-M1',
    marketKeys: ['D1-M1|series_win|A', 'D1-M1|exact_2_1|A', 'D1-M1|sweep_3_0|A'],
    multipliers: [2, 3, 4],
    goalTotalLine: 10.5,
    goalTotalBoost: 1.5
  });
  const opportunities = [{
    key: 'series:D1-M1',
    kind: 'series',
    divisionId: 'D1',
    label: 'A at B'
  }];
  db.setWutMissionBetOpportunities({ week, opportunities });
  db.placeOrUpdateBet({ userId: 1, week, divisionId: 'D1', seriesKey: 'D1-M1', marketKey: 'D1-M1|series_win|A', marketType: 'series_win', teamId: 'A', label: 'A wins series', stake: 50, multiplier: 2 });
  const beforeLock = db.getWutMissionsForUser(1).weekly.find(mission => mission.id === 'category_coverage');
  assert.equal(beforeLock.target, 1, 'the three outcomes belong to one series option');
  assert.equal(beforeLock.progress, 1);
  assert.equal(beforeLock.complete, false);
  assert.match(beforeLock.progressLabel, /ready for lock/i);
  db.setWutMissionBetOpportunities({ week, opportunities, locked: true });
  db.setWeekLocked(week, true);
  const afterLock = db.getWutMissionsForUser(1).weekly.find(mission => mission.id === 'category_coverage');
  assert.equal(afterLock.progress, 1);
  assert.equal(afterLock.complete, true);
  const failedCoverage = db.getWutMissionsForUser(missedUser.id).weekly.find(mission => mission.id === 'category_coverage');
  assert.equal(failedCoverage.complete, false);
  assert.equal(failedCoverage.failed, true);
  assert.match(failedCoverage.progressLabel, /failed/i);
  const failedProfit = db.getWutMissionsForUser(missedUser.id).weekly.find(mission => mission.id === 'profit_500');
  assert.equal(failedProfit.failed, true, 'a locked board with no unsettled tickets is finalized');
  db.setWeekLocked(week, false);
});

test('admin WUT configuration persists trinket economy, odds, rewards, and numeric effects', () => {
  const current = db.getCardsConfig();
  const existingTrinket = db.grantCardsTestItem({ userId: 1, item: { itemType: 'trinket', family: 'safety_net', rarity: 'rare' } });
  db.saveCardsConfig({
    playerPackPrices: current.playerPackPrices,
    playerTierOdds: current.playerTierOdds,
    boostRarityOdds: current.boostRarityOdds,
    boostPack: {
      price: 333,
      commonRareRolls: 3,
      guaranteedHighRolls: 2,
      commonRareOdds: { common: 50, uncommon: 35, rare: 15 },
      guaranteedHighOdds: { epic: 80, legendary: 20 }
    },
    boostEffects: current.boostEffects,
    scoring: current.scoring,
    wut: {
      slotPowerAllowance: 2,
      boostLoadCap: 6,
      rewards: { winner: 77, loser: 31, forfeitLoser: 4 },
      deckSlotCosts: { 4: 501, 5: 1001, 6: 2001, 7: 3501, 8: 5001 },
      trinketPrices: { common: 111, uncommon: 251, rare: 601, epic: 1501, legendary: 4001 },
      trinketPowerValues: { common: 0, uncommon: 0.5, rare: 1, epic: 1.5, legendary: 2.5 },
      trinketRemovalWut: { common: 26, uncommon: 76, rare: 151, epic: 301, legendary: 751 },
      trinketRemovalMushy: { common: 101, uncommon: 251, rare: 501, epic: 1001, legendary: 2501 },
      shopReroll: { wut: 251, mushy: 751 },
      trinketShopOdds: { 1: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 100 } },
      missionRewards: { daily_play_three: 41, daily_first_win: 21, daily_rotating: 31, weekly_profit_500: 101, weekly_category_coverage: 126, weekly_rotating: 127 },
      trinketEffects: { safety_net: { rare: { value: 61.5 } }, team_crest: { legendary: { value: 7 } } }
    },
    arena: { turnHours: 3, pauseStartHour: 1, pauseEndHour: 7, maxActiveMatches: 4 }
  });
  const saved = db.getCardsAdminState();
  assert.equal(saved.config.boostPackPrices, undefined);
  assert.deepEqual(saved.config.boostPack, {
    price: 333,
    commonRareRolls: 3,
    guaranteedHighRolls: 2,
    commonRareOdds: { common: 50, uncommon: 35, rare: 15 },
    guaranteedHighOdds: { epic: 80, legendary: 20 }
  });
  assert.equal(saved.config.wut.slotPowerAllowance, 2);
  assert.equal(saved.config.wut.boostLoadCap, 6);
  assert.equal(saved.config.wut.trinketPrices.common, 111);
  assert.equal(saved.config.wut.trinketPowerValues.legendary, 2.5);
  assert.equal(saved.config.wut.shopReroll.mushy, 751);
  assert.equal(saved.config.wut.missionRewards.daily_play_three, 41);
  assert.equal(saved.config.wut.trinketEffects.safety_net.rare, 0.615);
  assert.equal(saved.config.wut.trinketEffects.team_crest.legendary, 0.07);
  assert.equal(saved.arenaConfig.turnHours, 3);
  assert.equal(saved.arenaConfig.maxActiveMatches, 4);
  assert.equal(db.getWutSystemsState(1).trinkets.find(item => item.id === existingTrinket.id).effect, 0.615, 'owned trinkets receive the saved live value');

  const trinket = db.grantCardsTestItem({ userId: 1, item: { itemType: 'trinket', family: 'safety_net', rarity: 'rare' } });
  assert.equal(trinket.effect, 0.615, 'newly granted trinkets use the saved balance table');
  db.setWutFreeShopPurchases(true);
  const shop = db.rerollWutTrinketShop({ userId: 1, currency: 'wut' });
  assert.equal(shop.offers.find(offer => offer.slot === 1).rarity, 'legendary');
  assert.equal(shop.offers.find(offer => offer.slot === 1).price, 4001);
  assert.equal(db.getWutMissionsForUser(1).daily.find(mission => mission.id === 'play_three').reward, 41);
});

test('legacy trinket migration reset clears saved WUT decks', () => {
  const user = db.addUser({ username: `legacy-trinket-reset-${Date.now()}`, password: 'test-password', displayName: 'Legacy Trinket Reset' });
  db.joinWut(user.id);
  db.openWutStarterPack({
    userId: user.id,
    items: ['F', 'F', 'D', 'D', 'G'].map((position, index) => ({
      itemType: 'player',
      rolledTier: 'common',
      position,
      cardIdentity: `S3|LEGACYRESET|${index}`,
      catalogKey: `S3|LEGACYRESET|${index}`,
      edition: 'S3',
      divisionId: 'LEGACYRESET',
      playerKey: String(index)
    }))
  });
  const catalogByIdentity = {};
  saveConstructedTestDeck(user.id, 'LEGACYRESET', catalogByIdentity);
  assert.ok(db.getWutSystemsState(user.id).decks.length > 0);
  const result = db.refundWutTrinketRemovalFees({ adminUserId: 1 });
  assert.ok(result.clearedDecks > 0);
  assert.equal(db.getWutSystemsState(user.id).decks.length, 0);
});

test('admin WUT Coin adjustments are signed, audited, and cannot overdraw', () => {
  const before = db.getWutMembershipState(1).wutCoins;
  const granted = db.adjustWutCoinBalance({ userId: 1, amount: 125, note: 'Launch support grant', adminUserId: 1 });
  assert.equal(granted.balance, before + 125);
  const removed = db.adjustWutCoinBalance({ userId: 1, amount: -25, note: 'Correct duplicate grant', adminUserId: 1 });
  assert.equal(removed.balance, before + 100);
  assert.throws(() => db.adjustWutCoinBalance({ userId: 1, amount: -(before + 101), note: 'Too much', adminUserId: 1 }), /insufficient/i);
  assert.throws(() => db.adjustWutCoinBalance({ userId: 1, amount: 1, note: '', adminUserId: 1 }), /reason is required/i);
  const recent = db.getCardsAdminState().recentWutAdjustments;
  assert.equal(recent[0].amount, -25);
  assert.equal(recent[0].balance_after, before + 100);
  assert.equal(recent[0].note, 'Correct duplicate grant');
  assert.equal(recent[0].admin_user_id, 1);
});

test('URL-encoded Admin numeric keys save without array-index shifting', () => {
  const current = db.getCardsConfig();
  const submitted = qs.parse([
    'wut[trinketShopOdds][slot1][common]=91',
    'wut[trinketShopOdds][slot1][uncommon]=9',
    'wut[trinketShopOdds][slot1][rare]=0',
    'wut[trinketShopOdds][slot1][epic]=0',
    'wut[trinketShopOdds][slot1][legendary]=0',
    'wut[trinketShopOdds][slot2][common]=0',
    'wut[trinketShopOdds][slot2][uncommon]=64',
    'wut[trinketShopOdds][slot2][rare]=36',
    'wut[trinketShopOdds][slot2][epic]=0',
    'wut[trinketShopOdds][slot2][legendary]=0',
    'wut[trinketShopOdds][slot3][common]=0',
    'wut[trinketShopOdds][slot3][uncommon]=0',
    'wut[trinketShopOdds][slot3][rare]=0',
    'wut[trinketShopOdds][slot3][epic]=80',
    'wut[trinketShopOdds][slot3][legendary]=20',
    'wut[deckSlotCosts][slot4]=444',
    'wut[trinketEffects][team_crest][legendary][value]=7',
    'wut[trinketEffects][generalist][common][minCategories]=4',
    'wut[trinketEffects][generalist][common][maxBonus]=18'
  ].join('&'));
  db.saveCardsConfig({
    playerPackPrices: current.playerPackPrices,
    playerTierOdds: current.playerTierOdds,
    boostRarityOdds: current.boostRarityOdds,
    boostEffects: current.boostEffects,
    scoring: current.scoring,
    wut: submitted.wut
  });
  const saved = db.getCardsConfig().wut;
  assert.deepEqual(saved.trinketShopOdds['1'], { common: 91, uncommon: 9, rare: 0, epic: 0, legendary: 0 });
  assert.deepEqual(saved.trinketShopOdds['2'], { common: 0, uncommon: 64, rare: 36, epic: 0, legendary: 0 });
  assert.deepEqual(saved.trinketShopOdds['3'], { common: 0, uncommon: 0, rare: 0, epic: 80, legendary: 20 });
  assert.equal(saved.deckSlotCosts['4'], 444);
  assert.equal(saved.trinketEffects.team_crest.legendary, .07);
  assert.deepEqual(saved.trinketEffects.generalist.common, { minCategories: 4, maxBonus: .18 });
});

test('Arena queues are separate by mode for the same user', async () => {
  const catalog = await cards.buildCardPlayerCatalog();
  const catalogByIdentity = {};
  const user = createWutReadyUser('QUEUE-DUAL', catalogByIdentity);
  const deck = saveConstructedTestDeck(user.id, 'QUEUE-DUAL', catalogByIdentity);

  db.enterArenaQueue(user.id, { mode: 'draft', catalog });
  db.enterArenaQueue(user.id, { mode: 'constructed', deckId: deck.id, catalogByIdentity, catalog });

  const arena = db.getArenaStateForUser(user.id);
  assert.ok(arena.queuedEntries.draft, 'Draft Arena queue entry should be tracked separately');
  assert.ok(arena.queuedEntries.constructed, 'Constructed Arena queue entry should be tracked separately');
  assert.equal(arena.queueCounts.draft >= 1, true);
  assert.equal(arena.queueCounts.constructed >= 1, true);
  assert.throws(() => db.enterArenaQueue(user.id, { mode: 'draft', catalog }), /already in the Draft Arena queue/);
  assert.throws(() => db.enterArenaQueue(user.id, { mode: 'constructed', deckId: deck.id, catalogByIdentity, catalog }), /already in the Constructed Arena queue/);

  const draftOpponent = createWutReadyUser('QUEUE-DUAL-DRAFT-OPP', catalogByIdentity);
  db.enterArenaQueue(draftOpponent.id, { mode: 'draft', catalog });
  const constructedOpponent = createWutReadyUser('QUEUE-DUAL-CON-OPP', catalogByIdentity);
  const opponentDeck = saveConstructedTestDeck(constructedOpponent.id, 'QUEUE-DUAL-CON-OPP', catalogByIdentity);
  db.enterArenaQueue(constructedOpponent.id, { mode: 'constructed', deckId: opponentDeck.id, catalogByIdentity, catalog });
  db.assignArenaMatchups(new Date(), catalog);

  const after = db.getArenaStateForUser(user.id);
  assert.equal(after.queuedEntries.draft, null);
  assert.equal(after.queuedEntries.constructed, null);
  assert.equal(after.activeCounts.draft, 1);
  assert.equal(after.activeCounts.constructed, 1);
});

test('Arena active match cap is enforced per mode', async () => {
  const catalog = await cards.buildCardPlayerCatalog();
  const catalogByIdentity = {};
  const user = createWutReadyUser('QUEUE-CAP', catalogByIdentity);
  const modeLimit = db.getArenaStateForUser(user.id).config.maxActiveMatches;

  for (let index = 0; index < modeLimit; index += 1) {
    const opponent = createWutReadyUser(`QUEUE-CAP-DRAFT-${index}`, catalogByIdentity);
    db.enterArenaQueue(user.id, { mode: 'draft', catalog });
    db.enterArenaQueue(opponent.id, { mode: 'draft', catalog });
    db.assignArenaMatchups(new Date(Date.now() + index), catalog);
  }

  const capped = db.getArenaStateForUser(user.id);
  assert.equal(capped.activeCounts.draft, modeLimit);
  assert.equal(capped.activeCounts.constructed, 0);
  assert.throws(() => db.enterArenaQueue(user.id, { mode: 'draft', catalog }), new RegExp(`${modeLimit} active Draft Arena matches`));

  const deck = saveConstructedTestDeck(user.id, 'QUEUE-CAP-CON', catalogByIdentity);
  db.enterArenaQueue(user.id, { mode: 'constructed', deckId: deck.id, catalogByIdentity, catalog });
  const opponent = createWutReadyUser('QUEUE-CAP-CON-OPP', catalogByIdentity);
  const opponentDeck = saveConstructedTestDeck(opponent.id, 'QUEUE-CAP-CON-OPP', catalogByIdentity);
  db.enterArenaQueue(opponent.id, { mode: 'constructed', deckId: opponentDeck.id, catalogByIdentity, catalog });
  db.assignArenaMatchups(new Date(), catalog);

  const after = db.getArenaStateForUser(user.id);
  assert.equal(after.activeCounts.draft, modeLimit);
  assert.equal(after.activeCounts.constructed, 1);
});

test('Draft Arena packs preserve boost effects and scoring source identity', async () => {
  const catalog = (await cards.buildCardPlayerCatalog()).filter(player => player.edition === 'S3' && player.tier === 'common' && player.position === 'F');
  assert.ok(catalog.length, 'fixture needs at least one eligible S3 common forward');
  const packs = arenaRuntime.buildArenaDraftPacks({
    catalog,
    config: {
      draftArena: {
        packCount: 1,
        playersPerPack: 1,
        trinketsPerPack: 0,
        boostsPerPack: 1,
        rarityWeights: { common: 1, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
        maxPacks: { common: 1, uncommon: 0, rare: 0, epic: 0, legendary: 0 }
      }
    },
    wutConfig: db.getCardsConfig().wut,
    boostTypes: ['goal'],
    boostEffect: (type, rarity) => db.getCardsConfig().boostEffects[type][rarity],
    random: () => 0
  });
  const pack = packs[0];
  assert.deepEqual(pack.boosts[0].effect, db.getCardsConfig().boostEffects.goal.common);
  assert.ok(pack.players[0].player_snapshot.divisionId, 'draft player snapshot keeps current division');
  assert.ok(pack.players[0].player_snapshot.sourceDivisionId, 'draft player snapshot keeps scoring source division');
});

test('historical scoring does not crash when a legacy snapshot references a missing division', async () => {
  const result = await cards.scoreHistoricalCardSample({
    player: {
      name: 'Legacy Missing Division',
      baseName: 'Legacy Missing Division',
      sourceSeason: 'S3',
      sourceDivisionId: 'NOT-A-DIVISION',
      sourceSteamId: 'missing-steam'
    },
    position: 'F'
  });
  assert.equal(result.fp, 0);
  assert.match(result.warning, /source division NOT-A-DIVISION was not found/);
});
