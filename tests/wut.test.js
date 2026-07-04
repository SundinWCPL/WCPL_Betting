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

test('rarities rank S1+S2 together and S3 separately within exact positions', async () => {
  const catalog = (await cards.buildCardPlayerCatalog()).filter(player => player.cardType !== 'mythic' && player.position);
  const tierForRank = (index, total) => {
    const percentile = total ? index / total : 1;
    if (percentile < 0.05) return 'legendary';
    if (percentile < 0.15) return 'epic';
    if (percentile < 0.35) return 'rare';
    if (percentile < 0.70) return 'uncommon';
    return 'common';
  };
  for (const position of ['F', 'D', 'G']) {
    for (const seasonPool of ['historical', 'S3']) {
      const allPositionCards = catalog.filter(player => player.position === position && (seasonPool === 'S3' ? player.edition === 'S3' : ['S1', 'S2'].includes(player.edition)));
      const pool = allPositionCards.filter(player => player.rarityGamesPlayed >= 6)
        .sort((a, b) => b.expectedWutFpPerMatch - a.expectedWutFpPerMatch || a.catalogKey.localeCompare(b.catalogKey));
      if (seasonPool === 'historical') assert.deepEqual([...new Set(pool.map(player => player.edition))].sort(), ['S1', 'S2']);
      let previousFp = null;
      let previousTier = null;
      pool.forEach((player, index) => {
        const tied = previousFp != null && Math.abs(player.expectedWutFpPerMatch - previousFp) < 1e-9;
        const expected = tied ? previousTier : tierForRank(index, pool.length);
        assert.equal(player.tier, expected, `${player.catalogKey} should rank within its ${seasonPool} ${position} pool`);
        previousFp = player.expectedWutFpPerMatch;
        previousTier = expected;
      });
      const provisional = allPositionCards.filter(player => player.rarityGamesPlayed < 6);
      provisional.forEach(player => {
        const tied = pool.find(item => Math.abs(item.expectedWutFpPerMatch - player.expectedWutFpPerMatch) < 1e-9);
        const playersAhead = pool.filter(item => item.expectedWutFpPerMatch > player.expectedWutFpPerMatch).length;
        assert.equal(player.tier, tied?.tier || tierForRank(playersAhead, pool.length));
        assert.equal(player.rarityEligible, false);
        assert.equal(player.rarityProvisional, true);
      });
    }
  }
  assert.ok(catalog.some(player => player.edition === 'S3' && player.rarityGamesPlayed < 6), 'fixture must include sub-six-game S3 cards');
  assert.ok(catalog.every(player => Math.abs(player.expectedWutFpPerMatch - player.weightedFpPerGame * 3) < 1e-9));
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
    [{ id: 10 }, { id: 11 }, { id: 12 }],
    [{ user_id: 1, card_id: 10 }, { user_id: 2, card_id: 11 }],
    1
  );
  assert.deepEqual(available.map(card => card.id), [11, 12]);
});

test('new WUT users receive the complete starter bundle', () => {
  db.initDb();
  db.joinWut(1);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  const items = positions.map((position, index) => ({ itemType: 'player', rolledTier: 'common', position, cardIdentity: `S3|D1|starter-${index}`, catalogKey: `S3|D1|starter-${index}`, edition: 'S3', divisionId: 'D1', playerKey: `starter-${index}` }));
  db.openWutStarterPack({ userId: 1, items });
  const state = db.getWutSystemsState(1);
  assert.deepEqual(db.getCardsConfig().playerPackPrices, { standard: 250, premium: 500, prestige: 1000 });
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
  assert.equal(state.decks.length, 1);
  assert.deepEqual(state.decks[0].active_card_ids, state.decks[0].bench_card_ids);
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
      safetyBench: { mode: 'random_shared', rarityMin: 'common', rarityMax: 'common' },
      boosters: { countPerPlayer: 1, contents: { players: 1, boosts: 0, trinkets: 0 }, rarityOdds: { players: { common: 100 } }, pool: { allowDuplicateInBooster: false, allowDuplicateInEvent: true } },
      draft: { pickSeconds: 30, autopick: { enabled: true, priority: ['player', 'rarity', 'random'] } },
      deckbuilding: { seconds: 300, activeMinimum: 1, activeMaximum: 1, ...deckbuilding },
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
  db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  while (db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase === 'draft') db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  let current = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  for (const userId of userIds) {
    const inventory = current.inventories[String(userId)];
    const drafted = inventory.cards.find(card => !(inventory.safety_bench_card_ids || []).map(Number).includes(Number(card.id)));
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
  const live = db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1 });
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

test('Draft Event Safety Bench always uses Common cards from eligible seasons independently of booster rarities', () => {
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
    { cardIdentity: 'S3|A|common', edition: 'S3', position: 'G', tier: 'common' }
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

test('shared Safety Bench voting distributes identical temporary cards without touching permanent collections', () => {
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
  const byPosition = position => voting.bench.candidates.filter(candidate => candidate.position === position).map(candidate => candidate.card.cardIdentity);
  const selections = { F: byPosition('F').slice(0, 2), D: byPosition('D').slice(0, 2), G: byPosition('G').slice(0, 1) };
  db.voteWutDraftSafetyBench({ eventId: event.id, userId: 1, selections });
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

test('expired Safety Bench voting resolves from its persisted deadline after a clock restart', () => {
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
  const drafting = db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, random: () => 0.25 });
  assert.equal(drafting.phase, 'draft');
  const packs = drafting.draft.boosters;
  assert.equal(packs.length, 2);
  const composition = pack => pack.items.map(item => `${item.item_type}:${item.rarity}`);
  assert.deepEqual(composition(packs[0]), composition(packs[1]));
  assert.notEqual(packs[0].items.find(item => item.item_type === 'player').card_identity, packs[1].items.find(item => item.item_type === 'player').card_identity);

  const firstPack = packs.find(pack => Number(pack.current_owner_user_id) === 1);
  db.pickWutDraftItem({ eventId: event.id, userId: 1, itemId: firstPack.items[0].id, now: new Date('2026-07-04T22:00:00Z') });
  const forced = db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, now: new Date('2026-07-04T22:00:01Z'), random: () => 0.1 });
  assert.equal(forced.picks.length, 1);
  assert.equal(forced.event.draft.current_pick, 2);
  assert.ok(forced.event.draft.pass_log.every(row => row.direction === 'left'));
  while (db.getWutDraftEventLobby({ eventId: event.id })[0].phase === 'draft') {
    db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, now: new Date('2026-07-04T22:00:02Z'), random: () => 0.1 });
  }
  const completed = db.getWutDraftEventLobby({ eventId: event.id })[0];
  assert.equal(completed.phase, 'deckbuilding');
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
  db.transitionWutDraftEvent({ eventId: event.id, nextPhase: 'signup_closed', adminUserId: 1 });
  const playerPool = Array.from({ length: 5 }, (_, index) => ({
    cardIdentity: `S3|EVENTDECK|${index}`, displayName: `Event Player ${index}`, edition: 'S3',
    position: index < 2 ? 'F' : index < 4 ? 'D' : 'G', tier: 'common', stars: 1
  }));
  const config = db.getCardsConfig();
  db.startWutDraftEvent({ eventId: event.id, environment: { cards: playerPool, rules: { boostEffects: config.boostEffects, trinketEffects: config.wut.trinketEffects, rarityCosts: config.wut.rarityCosts, trinketPowerValues: config.wut.trinketPowerValues } }, adminUserId: 1 });
  db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, random: () => 0.1 });
  while (db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase === 'draft') {
    db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, random: () => 0.1 });
  }
  let building = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  const inventory = building.inventories['1'];
  assert.equal(inventory.cards.length, 5);
  assert.equal(inventory.trinkets.length, 1);
  const skater = inventory.cards.find(card => card.player_snapshot.position !== 'G');
  db.attachWutDraftEventTrinket({ eventId: event.id, userId: 1, cardId: skater.id, trinketId: inventory.trinkets[0].id });
  building = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.equal(building.inventories['1'].cards.find(card => card.id === skater.id).power, 1);
  assert.throws(() => db.saveWutDraftEventDeck({ eventId: event.id, userId: 1, activeCardIds: inventory.cards.slice(0, 4).map(card => card.id) }), /between 5 and 5/);
  const saved = db.saveWutDraftEventDeck({ eventId: event.id, userId: 1, activeCardIds: inventory.cards.map(card => card.id) });
  assert.equal(saved.event.phase, 'complete', 'a one-player recovery event finishes without generating a fake matchup');
  assert.equal(saved.deck.active_snapshots.find(card => card.event_item_id === skater.id).trinket.id, inventory.trinkets[0].id);
  assert.equal(saved.deck.active_snapshots.find(card => card.event_item_id === skater.id).power, 1);
  assert.throws(() => db.detachWutDraftEventTrinket({ eventId: event.id, userId: 1, cardId: skater.id }), /locked/);
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
      safetyBench: { mode: 'random_shared', rarityMin: 'common', rarityMax: 'common' },
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
  db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  while (db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0].phase === 'draft') db.forceWutDraftAutopick({ eventId: event.id, adminUserId: 1, random: () => 0.2 });
  let state = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  for (const userId of [1, opponent.id]) {
    const inventory = state.inventories[String(userId)];
    const drafted = inventory.cards.find(card => !(inventory.safety_bench_card_ids || []).map(Number).includes(Number(card.id)));
    db.saveWutDraftEventDeck({ eventId: event.id, userId, activeCardIds: [drafted.id] });
  }
  state = db.getWutDraftEventLobby({ eventId: event.id, includePrivate: true })[0];
  assert.equal(state.phase, 'tournament');
  assert.equal(state.tournament.matches.length, 1);
  const matchId = state.tournament.matches[0].id;
  while (true) {
    const view = db.getWutDraftEventMatch({ eventId: event.id, matchId, userId: 1 });
    if (view.match.status !== 'active') break;
    const userId = view.match.current_player_id; const required = view.match.cards_required_this_turn;
    const snapshots = [...view.match.deck_snapshots[String(userId)].active, ...view.match.deck_snapshots[String(userId)].bench];
    const occupied = new Set(view.match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => row.slot));
    const used = new Set(view.match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id)));
    const choices = [];
    for (const slot of ['F1', 'F2', 'D1', 'D2', 'G'].filter(slot => !occupied.has(slot))) {
      const position = slot === 'G' ? 'G' : slot[0];
      const card = snapshots.find(item => item.position === position && !used.has(Number(item.card_id)) && !choices.some(choice => Number(choice.cardId) === Number(item.card_id)));
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
    { name: 'Audit Elimination', entrants: 7, tournament: { format: 'single_elimination', elimination: { seeding: 'draft_order', thirdPlaceMatch: true, consolationMatch: true } }, expectedRounds: 3 },
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
  db.processWutDraftEvents(new Date(shiftedDeadline.getTime() + 1));
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
  db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: null, system: true, now: starts, random: () => 0.2 });
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
  assert.throws(() => db.beginWutDraftSafetyBench({ eventId: event.id, adminUserId: 1, random: () => 0.5 }), /Not enough unique legendary/);
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

  const firstDeck = db.getWutSystemsState(1).decks[0];
  const secondDeck = db.getWutSystemsState(userTwo.id).decks[0];
  db.enterArenaQueue(1, firstDeck.id, catalogByIdentity);
  db.enterArenaQueue(userTwo.id, secondDeck.id, catalogByIdentity);
  db.assignArenaMatchups();

  while (true) {
    const arena = db.getArenaStateForUser(1);
    const match = arena.activeMatches[0];
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

  const scoring = db.getArenaMatchesNeedingScoring().find(match => !String(match.id).startsWith('debug-'));
  assert.ok(scoring);
  db.completeArenaMatch(scoring.id, scoring.placements.map(row => ({ ...row, fp: Number(row.user_id) === 1 ? 20 : 10 })));
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
    db.enterArenaQueue(user.id, db.getWutSystemsState(user.id).decks[0].id, catalogByIdentity);
  }
  db.assignArenaMatchups();
  const match = db.getArenaStateForUser(first.id).activeMatches[0];
  assert.ok(match);
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
      trinketEffects: { safety_net: { rare: { value: 61.5 } } }
    },
    arena: { turnHours: 3, pauseStartHour: 1, pauseEndHour: 7, maxActiveMatches: 4 }
  });
  const saved = db.getCardsAdminState();
  assert.equal(saved.config.boostPackPrices, undefined);
  assert.equal(saved.config.wut.slotPowerAllowance, 2);
  assert.equal(saved.config.wut.boostLoadCap, 6);
  assert.equal(saved.config.wut.trinketPrices.common, 111);
  assert.equal(saved.config.wut.trinketPowerValues.legendary, 2.5);
  assert.equal(saved.config.wut.shopReroll.mushy, 751);
  assert.equal(saved.config.wut.missionRewards.daily_play_three, 41);
  assert.equal(saved.config.wut.trinketEffects.safety_net.rare, 0.615);
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
    'wut[trinketEffects][generalist][common][value3]=9',
    'wut[trinketEffects][generalist][common][value4]=12',
    'wut[trinketEffects][generalist][common][value5]=15'
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
  assert.deepEqual(saved.trinketEffects.generalist.common, { 3: .09, 4: .12, 5: .15 });
});
