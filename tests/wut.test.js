import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `wcpl-wut-${process.pid}.json`);
process.env.JSON_DB_PATH = dbPath;
const db = await import('../db.js');
const cards = await import('../services/cards.js');

test.after(() => { try { fs.unlinkSync(dbPath); } catch {} });

test('Power includes card and trinket rarity, never boosts', () => {
  assert.equal(db.calculateWutPower('common'), 1);
  assert.equal(db.calculateWutPower('common', 'legendary'), 6);
  assert.equal(db.calculateWutPower('legendary', 'legendary'), 10);
  assert.equal(db.calculateWutPower('mythic'), 6);
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

test('new WUT users receive the complete starter bundle', () => {
  db.initDb();
  db.joinWut(1);
  const positions = ['F', 'F', 'D', 'D', 'G'];
  const items = positions.map((position, index) => ({ itemType: 'player', rolledTier: 'common', position, cardIdentity: `S3|D1|starter-${index}`, catalogKey: `S3|D1|starter-${index}`, edition: 'S3', divisionId: 'D1', playerKey: `starter-${index}` }));
  db.openWutStarterPack({ userId: 1, items });
  const state = db.getWutSystemsState(1);
  assert.deepEqual(db.getCardsAdminState().config.scoring.chemistryBonuses, { 2: 10, 3: 15, 4: 20, 5: 25 });
  assert.equal(state.deckSlots, 3);
  assert.equal(state.decks.length, 1);
  assert.deepEqual(state.decks[0].active_card_ids, state.decks[0].bench_card_ids);
  assert.equal(state.trinkets.length, 2);
  assert.ok(state.trinkets.every(trinket => trinket.rarity === 'common' && trinket.source === 'starter_pack'));
  assert.equal(new Set(state.trinkets.map(trinket => trinket.family)).size, 2);
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
  assert.equal(db.getWutMembershipState(1).wutCoins, 0);
  const freeReroll = db.rerollWutTrinketShop({ userId: 1, currency: 'wut' });
  assert.equal(freeReroll.offers.length, 3);
  assert.equal(db.getWutMembershipState(1).wutCoins, 0);
  const purchase = db.createCardsPackPurchase({ userId: 1, week: 1, packKind: 'player', packType: 'standard', price: 250, items: [
    ...items.slice(0, 3),
    { itemType: 'boost', boostType: 'goal', rarity: 'common' },
    { itemType: 'boost', boostType: 'grit', rarity: 'common' }
  ] });
  assert.equal(purchase.price, 0);
  assert.equal(purchase.free_purchase, true);
  assert.equal(db.getWutMembershipState(1).wutCoins, 0);

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
  assert.equal(db.getWutMembershipState(1).wutCoins, 0, 'debug games never award currency');
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
  assert.equal(db.getWutMissionsForUser(1).daily.find(mission => mission.id === 'play_three').reward, 41);
});
