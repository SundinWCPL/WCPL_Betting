import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import {
  HORSE_RACING_CONFIG,
  getHorseRaceCardDateKey,
  getHorseRaceDateKey,
  getHorseRaceSchedule,
  getScheduledHorseRaceStatus,
  nextDateKey,
  randomHorseRaceDurationSeconds,
  shuffledHorseIds
} from './services/horseRacing.js';

const dbPath = path.resolve(process.env.JSON_DB_PATH || './betting.json');
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'));
const ARENA_ENTRY_FEE = 0;
const ARENA_WINNER_PRIZE = 50;

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function defaultState() {
  return {
    settings: {
      currentWeek: Number(process.env.CURRENT_WEEK || 1),
      lockedWeeks: [],
      bettingLocked: false,
      weeklyAllowance: Number(process.env.WEEKLY_ALLOWANCE || 100),
      seasonId: process.env.SEASON_ID || 'S3',
      casinoOpen: true,
      casinoLinkVisible: false,
      cardsOpen: true,
      cardsLinkVisible: false,
      cardsAllowRetroactiveAssignment: false
    },
    users: [],
    bets: [],
    transactions: [],
    oddsAdjustments: {
      series: {},
      goalTotals: {},
      propDefaults: {},
      propPlayerOverrides: {},
      seriesProps: {}
    },
    casino: {
      jackpotAmount: Number(process.env.CASINO_JACKPOT_SEED || 1000),
      jackpotSeed: Number(process.env.CASINO_JACKPOT_SEED || 1000),
      totalWagered: 0,
      totalPaid: 0,
      spins: [],
      shotDoctorRuns: [],
      horseRacing: {
        config: {
          maxBet: HORSE_RACING_CONFIG.maxBet,
          horsePurchasePrice: HORSE_RACING_CONFIG.horsePurchasePrice,
          ownerBetSharePercent: HORSE_RACING_CONFIG.ownerBetShare * 100,
          ownerWinBonus: HORSE_RACING_CONFIG.ownerWinBonus
        },
        horses: HORSE_RACING_CONFIG.horses.map(horse => ({
          ...horse,
          owner_user_id: null,
          purchase_price: 0,
          races: 0,
          wins: 0,
          second_places: 0,
          total_finishing_position: 0,
          created_at: null
        })),
        ownerRewards: [],
        chat: { cardDate: '', messages: [], nextMessageId: 1 },
        races: [],
        bets: [],
        nextRaceId: 1,
        nextBetId: 1,
        nextHorseId: HORSE_RACING_CONFIG.horses.length + 1,
        nextOwnerRewardId: 1
      }
    },
    cards: {
      config: {
        playerPackPrices: { standard: 75, premium: 150, prestige: 350 },
        boostPackPrices: { standard: 50, premium: 100, prestige: 250 },
        playerTierOdds: {
          standard: { common: 55, uncommon: 25, rare: 13, epic: 6, legendary: 1, mythic: 0 },
          premium: { common: 25, uncommon: 30, rare: 25, epic: 15, legendary: 5, mythic: 0 },
          prestige: { common: 5, uncommon: 15, rare: 30, epic: 30, legendary: 20, mythic: 0 }
        },
        boostRarityOdds: {
          standard: { common: 55, uncommon: 25, rare: 13, epic: 6, legendary: 1, mythic: 0 },
          premium: { common: 25, uncommon: 30, rare: 25, epic: 15, legendary: 5, mythic: 0 },
          prestige: { common: 5, uncommon: 15, rare: 30, epic: 30, legendary: 20, mythic: 0 }
        },
        boostEffects: {
          goal: { common: { per: 1, bonus: 2 }, uncommon: { per: 1, bonus: 3 }, rare: { per: 1, bonus: 5 }, epic: { per: 1, bonus: 7 }, legendary: { per: 1, bonus: 10 } },
          assist: { common: { per: 1, bonus: 1 }, uncommon: { per: 1, bonus: 2 }, rare: { per: 1, bonus: 3 }, epic: { per: 1, bonus: 5 }, legendary: { per: 1, bonus: 7 } },
          shot: { common: { per: 4, bonus: 1 }, uncommon: { per: 3, bonus: 1 }, rare: { per: 2, bonus: 1 }, epic: { per: 1, bonus: 1 }, legendary: { per: 1, bonus: 2 } },
          hit: { common: { per: 1, bonus: 1 }, uncommon: { per: 1, bonus: 2 }, rare: { per: 1, bonus: 3 }, epic: { per: 1, bonus: 4 }, legendary: { per: 1, bonus: 6 } },
          block: { common: { per: 1, bonus: 2 }, uncommon: { per: 1, bonus: 3 }, rare: { per: 1, bonus: 4 }, epic: { per: 1, bonus: 6 }, legendary: { per: 1, bonus: 8 } },
          save: { common: { per: 8, bonus: 1 }, uncommon: { per: 5, bonus: 1 }, rare: { per: 3, bonus: 1 }, epic: { per: 2, bonus: 1 }, legendary: { per: 1, bonus: 1 } },
          shutout: { common: { per: 1, bonus: 5 }, uncommon: { per: 1, bonus: 10 }, rare: { per: 1, bonus: 15 }, epic: { per: 1, bonus: 25 }, legendary: { per: 1, bonus: 40 } }
        },
        scoring: {
          statPoints: { goal: 10, assist: 7, shot: 1, hit: 3, block: 4, save: 2, shutout: 10 },
          savePctBonuses: [
            { threshold: 0, multiplier: 0.85 },
            { threshold: 0.85, multiplier: 1 },
            { threshold: 0.9, multiplier: 1.1 },
            { threshold: 0.925, multiplier: 1.2 },
            { threshold: 0.95, multiplier: 1.35 },
            { threshold: 0.975, multiplier: 1.5 }
          ],
          chemistryBonuses: { 2: 10, 3: 15, 4: 25, 5: 50 }
        }
      },
      positionOverrides: {},
      tierOverrides: {},
      calculatedTiers: {},
      ownedCards: [],
      ownedBoosts: [],
      lineups: [],
      packPurchases: [],
      weekReviews: [],
      wutMemberships: [],
      arena: {
        config: {
          entryFee: ARENA_ENTRY_FEE,
          winnerPrize: ARENA_WINNER_PRIZE,
          timeZone: process.env.ARENA_TIME_ZONE || 'America/Los_Angeles',
          maxActiveMatches: Number(process.env.ARENA_MAX_ACTIVE_MATCHES || 3),
          turnHours: Number(process.env.ARENA_TURN_HOURS || 24)
        },
        lastMatchmakingHour: '',
        entries: [],
        matches: [],
        nextEntryId: 1,
        nextMatchId: 1
      }
    },
    nextUserId: 1,
    nextBetId: 1,
    nextTransactionId: 1,
    nextCasinoSpinId: 1,
    nextShotDoctorRunId: 1,
    nextOwnedCardId: 1,
    nextOwnedBoostId: 1,
    nextPackPurchaseId: 1
  };
}

let state = defaultState();

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  if (!fs.existsSync(dbPath)) return;
  const raw = fs.readFileSync(dbPath, 'utf8');
  if (!raw.trim()) return;
  state = { ...state, ...JSON.parse(raw) };
}

function saveState() {
  ensureDirForFile(dbPath);
  fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
}

function isWeekLockedInternal(week) {
  const target = Number(week);
  return (state.settings?.lockedWeeks || []).map(w => Number(w)).includes(target);
}

function setWeekLockedInternal(week, locked) {
  ensureSettings();
  const target = Number(week);
  if (!Number.isFinite(target) || target < 1) throw new Error('Invalid week.');
  const lockedWeeks = new Set((state.settings.lockedWeeks || []).map(w => Number(w)).filter(Number.isFinite));
  if (locked) lockedWeeks.add(target);
  else lockedWeeks.delete(target);
  state.settings.lockedWeeks = [...lockedWeeks].sort((a, b) => a - b);
  state.settings.bettingLocked = isWeekLockedInternal(state.settings.currentWeek);
}

function ensureSettings() {
  state.settings = {
    currentWeek: Number(process.env.CURRENT_WEEK || 1),
    lockedWeeks: [],
    bettingLocked: false,
    weeklyAllowance: Number(process.env.WEEKLY_ALLOWANCE || 100),
    seasonId: process.env.SEASON_ID || 'S3',
    casinoOpen: true,
    casinoLinkVisible: false,
    cardsOpen: true,
    cardsLinkVisible: false,
    cardsAllowRetroactiveAssignment: false,
    ...(state.settings || {})
  };
  state.settings.currentWeek = Number(state.settings.currentWeek || 1);
  state.settings.weeklyAllowance = Number(state.settings.weeklyAllowance || 100);
  state.settings.seasonId = String(state.settings.seasonId || process.env.SEASON_ID || 'S3');
  state.settings.casinoOpen = state.settings.casinoOpen !== false;
  state.settings.casinoLinkVisible = state.settings.casinoLinkVisible === true;
  state.settings.cardsOpen = state.settings.cardsOpen !== false;
  state.settings.cardsLinkVisible = state.settings.cardsLinkVisible === true;
  state.settings.cardsAllowRetroactiveAssignment = state.settings.cardsAllowRetroactiveAssignment === true;

  // Migration from the old single global lock flag. If an old database had
  // bettingLocked=true, treat that as "current week locked" and then move to
  // per-week lock tracking from here on out.
  const locked = new Set((state.settings.lockedWeeks || []).map(w => Number(w)).filter(Number.isFinite));
  if (state.settings.bettingLocked) locked.add(state.settings.currentWeek);
  state.settings.lockedWeeks = [...locked].sort((a, b) => a - b);
  state.settings.bettingLocked = isWeekLockedInternal(state.settings.currentWeek);

  state.oddsAdjustments = {
    series: {},
    goalTotals: {},
    propDefaults: {},
    propPlayerOverrides: {},
    seriesProps: {},
    ...(state.oddsAdjustments || {})
  };
}

function ensureCasinoState() {
  const seed = Number(process.env.CASINO_JACKPOT_SEED || 1000);
  state.casino = {
    jackpotAmount: seed,
    jackpotSeed: seed,
    totalWagered: 0,
    totalPaid: 0,
    spins: [],
    ...(state.casino || {})
  };
  state.casino.jackpotSeed = Number(state.casino.jackpotSeed || seed);
  state.casino.jackpotAmount = Number(state.casino.jackpotAmount || state.casino.jackpotSeed);
  state.casino.totalWagered = Number(state.casino.totalWagered || 0);
  state.casino.totalPaid = Number(state.casino.totalPaid || 0);
  state.casino.spins = Array.isArray(state.casino.spins) ? state.casino.spins : [];
  state.casino.shotDoctorRuns = Array.isArray(state.casino.shotDoctorRuns) ? state.casino.shotDoctorRuns : [];
  const storedHorseRacing = state.casino.horseRacing || {};
  const hadHorseRegistry = Array.isArray(storedHorseRacing.horses) && storedHorseRacing.horses.length > 0;
  state.casino.horseRacing = {
    config: {},
    horses: [],
    ownerRewards: [],
    chat: { cardDate: '', messages: [], nextMessageId: 1 },
    races: [],
    bets: [],
    nextRaceId: 1,
    nextBetId: 1,
    nextHorseId: HORSE_RACING_CONFIG.horses.length + 1,
    nextOwnerRewardId: 1,
    ...storedHorseRacing
  };
  state.casino.horseRacing.config = {
    maxBet: HORSE_RACING_CONFIG.maxBet,
    horsePurchasePrice: HORSE_RACING_CONFIG.horsePurchasePrice,
    ownerBetSharePercent: HORSE_RACING_CONFIG.ownerBetShare * 100,
    ownerWinBonus: HORSE_RACING_CONFIG.ownerWinBonus,
    ...(storedHorseRacing.config || {})
  };
  state.casino.horseRacing.config.maxBet = Math.max(1, Math.ceil(Number(state.casino.horseRacing.config.maxBet || HORSE_RACING_CONFIG.maxBet)));
  state.casino.horseRacing.config.horsePurchasePrice = Math.max(1, Math.ceil(Number(state.casino.horseRacing.config.horsePurchasePrice || HORSE_RACING_CONFIG.horsePurchasePrice)));
  state.casino.horseRacing.config.ownerBetSharePercent = Math.min(100, Math.max(0, Number(state.casino.horseRacing.config.ownerBetSharePercent ?? HORSE_RACING_CONFIG.ownerBetShare * 100)));
  state.casino.horseRacing.config.ownerWinBonus = Math.max(0, Math.ceil(Number(state.casino.horseRacing.config.ownerWinBonus ?? HORSE_RACING_CONFIG.ownerWinBonus)));
  state.casino.horseRacing.races = Array.isArray(state.casino.horseRacing.races)
    ? state.casino.horseRacing.races
    : [];
  state.casino.horseRacing.bets = Array.isArray(state.casino.horseRacing.bets)
    ? state.casino.horseRacing.bets
    : [];
  state.casino.horseRacing.horses = hadHorseRegistry
    ? state.casino.horseRacing.horses
    : HORSE_RACING_CONFIG.horses.map(horse => ({ ...horse }));
  const seedHorsesById = new Map(HORSE_RACING_CONFIG.horses.map(horse => [String(horse.id), horse]));
  for (const horse of state.casino.horseRacing.horses) {
    const seed = seedHorsesById.get(String(horse.id));
    if (seed && /^Horse [1-5]$/i.test(String(horse.name || ''))) horse.name = seed.name;
  }
  for (const race of state.casino.horseRacing.races) {
    for (const snapshot of race.horse_names || []) {
      const seed = seedHorsesById.get(String(snapshot.id));
      if (seed && /^Horse [1-5]$/i.test(String(snapshot.name || ''))) snapshot.name = seed.name;
    }
  }
  for (const bet of state.casino.horseRacing.bets) {
    const seed = seedHorsesById.get(String(bet.horse_id));
    if (seed && /^Horse [1-5]$/i.test(String(bet.horse_name || ''))) bet.horse_name = seed.name;
  }
  const knownHorseIds = new Set(state.casino.horseRacing.horses.map(horse => String(horse.id)));
  for (const race of state.casino.horseRacing.races) {
    for (const snapshot of race.horse_names || []) {
      if (knownHorseIds.has(String(snapshot.id))) continue;
      state.casino.horseRacing.horses.push({ id: String(snapshot.id), name: String(snapshot.name || snapshot.id) });
      knownHorseIds.add(String(snapshot.id));
    }
  }
  for (const horse of state.casino.horseRacing.horses) {
    horse.id = String(horse.id);
    horse.name = String(horse.name || horse.id).trim();
    horse.owner_user_id = horse.owner_user_id == null ? null : Number(horse.owner_user_id);
    horse.purchase_price = Math.max(0, Number(horse.purchase_price || 0));
    horse.races = Math.max(0, Number(horse.races || 0));
    horse.wins = Math.max(0, Number(horse.wins || 0));
    horse.second_places = Math.max(0, Number(horse.second_places || 0));
    horse.total_finishing_position = Math.max(0, Number(horse.total_finishing_position || 0));
    horse.created_at = horse.created_at || null;
  }
  if (!hadHorseRegistry) {
    const horsesById = new Map(state.casino.horseRacing.horses.map(horse => [horse.id, horse]));
    for (const race of state.casino.horseRacing.races) {
      if (!race.settled_at || !Array.isArray(race.finishing_order)) continue;
      race.finishing_order.forEach((horseId, index) => {
        const horse = horsesById.get(String(horseId));
        if (!horse) return;
        const position = index + 1;
        horse.races += 1;
        horse.total_finishing_position += position;
        if (position === 1) horse.wins += 1;
        if (position === 2) horse.second_places += 1;
      });
      race.stats_recorded_at = race.settled_at;
    }
  }
  state.casino.horseRacing.ownerRewards = Array.isArray(state.casino.horseRacing.ownerRewards)
    ? state.casino.horseRacing.ownerRewards
    : [];
  state.casino.horseRacing.chat = {
    cardDate: '',
    messages: [],
    nextMessageId: 1,
    ...(state.casino.horseRacing.chat || {})
  };
  state.casino.horseRacing.chat.messages = Array.isArray(state.casino.horseRacing.chat.messages)
    ? state.casino.horseRacing.chat.messages
    : [];
  state.casino.horseRacing.chat.nextMessageId = Math.max(
    Number(state.casino.horseRacing.chat.nextMessageId || 1),
    ...state.casino.horseRacing.chat.messages.map(message => Number(message.id || 0) + 1)
  );
  for (const race of state.casino.horseRacing.races) {
    race.race_number = Math.min(3, Math.max(1, Number(race.race_number || 3)));
  }
  state.casino.horseRacing.nextRaceId = Number(state.casino.horseRacing.nextRaceId || 1);
  state.casino.horseRacing.nextBetId = Number(state.casino.horseRacing.nextBetId || 1);
  state.casino.horseRacing.nextHorseId = Math.max(
    Number(state.casino.horseRacing.nextHorseId || 1),
    ...state.casino.horseRacing.horses.map(horse => Number(String(horse.id).match(/(\d+)$/)?.[1] || 0) + 1)
  );
  state.casino.horseRacing.nextOwnerRewardId = Number(state.casino.horseRacing.nextOwnerRewardId || 1);
  state.nextCasinoSpinId = Number(state.nextCasinoSpinId || 1);
  state.nextShotDoctorRunId = Number(state.nextShotDoctorRunId || 1);
}

function migrateCardsOddsGroup(saved, defaults) {
  const packTypes = ['standard', 'premium', 'prestige'];
  const isOldFlatShape = saved && typeof saved.common !== 'undefined';
  return Object.fromEntries(packTypes.map(packType => [
    packType,
    {
      ...defaults[packType],
      ...(isOldFlatShape && packType === 'standard' ? saved : saved?.[packType] || {})
    }
  ]));
}

function ensureCardsState() {
  const defaults = defaultState().cards;
  state.cards = {
    ...defaults,
    ...(state.cards || {}),
    config: {
      ...defaults.config,
      ...(state.cards?.config || {}),
      playerPackPrices: {
        ...defaults.config.playerPackPrices,
        ...(state.cards?.config?.playerPackPrices || {})
      },
      boostPackPrices: {
        ...defaults.config.boostPackPrices,
        ...(state.cards?.config?.boostPackPrices || {})
      },
      playerTierOdds: migrateCardsOddsGroup(state.cards?.config?.playerTierOdds, defaults.config.playerTierOdds),
      boostRarityOdds: migrateCardsOddsGroup(state.cards?.config?.boostRarityOdds, defaults.config.boostRarityOdds),
      scoring: {
        ...defaults.config.scoring,
        ...(state.cards?.config?.scoring || {}),
        statPoints: {
          ...defaults.config.scoring.statPoints,
          ...(state.cards?.config?.scoring?.statPoints || {})
        },
        chemistryBonuses: {
          ...defaults.config.scoring.chemistryBonuses,
          ...(state.cards?.config?.scoring?.chemistryBonuses || {})
        },
        savePctBonuses: Array.isArray(state.cards?.config?.scoring?.savePctBonuses)
          ? state.cards.config.scoring.savePctBonuses
          : defaults.config.scoring.savePctBonuses
      }
    }
  };
  state.cards.positionOverrides = { ...(state.cards.positionOverrides || {}) };
  state.cards.tierOverrides = { ...(state.cards.tierOverrides || {}) };
  state.cards.calculatedTiers = { ...(state.cards.calculatedTiers || {}) };
  state.cards.ownedCards = Array.isArray(state.cards.ownedCards) ? state.cards.ownedCards : [];
  for (const card of state.cards.ownedCards) {
    card.edition = String(card.edition || card.season || 'S3').trim().toUpperCase();
    if (!['S1', 'S2', 'S3', 'MYTHIC'].includes(card.edition)) card.edition = 'S3';
    card.card_type = String(card.card_type || 'player');
    card.source_season = String(card.source_season || card.edition || 'S3');
    card.source_stage = String(card.source_stage || 'reg');
    card.source_team_id = card.source_team_id || '';
    card.source_player_key = card.source_player_key || card.player_key || '';
    card.source_steam_id = card.source_steam_id || '';
    card.display_name = card.display_name || '';
    card.card_identity = card.card_identity || `${card.edition}|${card.division_id}|${card.player_key}`;
    card.fantasy_stats = card.fantasy_stats && typeof card.fantasy_stats === 'object' ? card.fantasy_stats : {};
    card.cooldown_remaining = Math.max(0, Number(card.cooldown_remaining || 0));
    // Contracts were removed by WUT. Previously retired cards return to the usable collection.
    card.retired = false;
  }
  state.cards.ownedBoosts = Array.isArray(state.cards.ownedBoosts) ? state.cards.ownedBoosts : [];
  for (const boost of state.cards.ownedBoosts) {
    if (String(boost.rarity).toLowerCase() === 'mythic') boost.rarity = 'legendary';
  }
  state.cards.lineups = Array.isArray(state.cards.lineups) ? state.cards.lineups : [];
  state.cards.packPurchases = Array.isArray(state.cards.packPurchases) ? state.cards.packPurchases : [];
  state.cards.weekReviews = Array.isArray(state.cards.weekReviews) ? state.cards.weekReviews : [];
  state.cards.wutMemberships = Array.isArray(state.cards.wutMemberships) ? state.cards.wutMemberships : [];
  state.cards.arena = {
    ...defaults.arena,
    ...(state.cards.arena || {}),
    config: { ...defaults.arena.config, ...(state.cards.arena?.config || {}) }
  };
  state.cards.arena.entries = Array.isArray(state.cards.arena.entries) ? state.cards.arena.entries : [];
  state.cards.arena.matches = Array.isArray(state.cards.arena.matches) ? state.cards.arena.matches : [];
  state.cards.arena.nextEntryId = Number(state.cards.arena.nextEntryId || 1);
  state.cards.arena.nextMatchId = Number(state.cards.arena.nextMatchId || 1);
  state.cards.arena.config.entryFee = ARENA_ENTRY_FEE;
  state.cards.arena.config.winnerPrize = ARENA_WINNER_PRIZE;
  for (const entry of state.cards.arena.entries.filter(item => item.status === 'queued' && Number(item.paid_amount || 0) > 0)) {
    const refund = Math.ceil(Number(entry.paid_amount || 0));
    const user = state.users.find(item => Number(item.id) === Number(entry.user_id));
    if (user) {
      user.balance = Number(user.balance || 0) + refund;
      const transaction = {
        id: state.nextTransactionId++,
        user_id: Number(entry.user_id),
        week: Number(state.settings.currentWeek || 1),
        amount: refund,
        kind: 'arena_entry_refund',
        category: 'cards',
        note: 'WUT queue entry refund after free-entry update',
        arena_entry_id: entry.id,
        created_at: nowIso()
      };
      state.transactions.push(transaction);
      entry.refund_transaction_id = transaction.id;
    }
    entry.original_paid_amount = refund;
    entry.paid_amount = 0;
    entry.free_entry_refunded_at = nowIso();
  }
  if (!process.env.ARENA_TIME_ZONE && state.cards.arena.config.timeZone === 'America/Edmonton') {
    state.cards.arena.config.timeZone = 'America/Los_Angeles';
  }
  if (!state.cards.arena.lastMatchmakingHour) {
    state.cards.arena.lastMatchmakingHour = arenaHourKey(new Date());
  }
  state.nextOwnedCardId = Number(state.nextOwnedCardId || 1);
  state.nextOwnedBoostId = Number(state.nextOwnedBoostId || 1);
  state.nextPackPurchaseId = Number(state.nextPackPurchaseId || 1);
}

function normalizeWholeMushybux() {
  for (const user of state.users || []) {
    user.balance = Math.ceil(Number(user.balance || 0));
  }
  for (const bet of state.bets || []) {
    bet.stake = Math.ceil(Number(bet.stake || 0));
    if (bet.payout != null) bet.payout = Math.ceil(Number(bet.payout || 0));
  }
  for (const bet of state.casino?.horseRacing?.bets || []) {
    bet.stake = Math.ceil(Number(bet.stake || 0));
    if (bet.payout != null) bet.payout = Math.round(Number(bet.payout || 0));
  }
}


export function getDatabasePath() {
  return dbPath;
}

export function getBackupInfo() {
  if (!fs.existsSync(backupDir)) {
    return { backupDir, latestBackup: null, backups: [] };
  }

  const backups = fs.readdirSync(backupDir)
    .filter(name => name.toLowerCase().endsWith('.json'))
    .map(name => {
      const fullPath = path.join(backupDir, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        fullPath,
        size: stat.size,
        createdAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return { backupDir, latestBackup: backups[0] || null, backups };
}

export function createJsonBackup() {
  loadState();
  ensureSettings();
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const safeIso = nowIso().replace(/[:.]/g, '-');
  const week = Number(state.settings?.currentWeek || 1);
  const filename = `betting-week-${week}-${safeIso}.json`;
  const fullPath = path.join(backupDir, filename);

  fs.writeFileSync(fullPath, JSON.stringify(state, null, 2));
  return { filename, fullPath, backupDir };
}

export function initDb() {
  loadState();
  ensureSettings();
  ensureCasinoState();
  ensureCardsState();
  normalizeWholeMushybux();
  removeDemoUsers();
  seedUser('Sundin', 'Sundin', 'admin', 'cactusgoat13');
  saveState();
}

function removeDemoUsers() {
  const demoNames = new Set(['logan', 'jay', 'dane', 'josh']);
  const demoIds = new Set(
    state.users
      .filter(u => demoNames.has(String(u.username || '').toLowerCase()))
      .map(u => Number(u.id))
  );

  if (!demoIds.size) return;

  state.users = state.users.filter(u => !demoIds.has(Number(u.id)));
  state.bets = state.bets.filter(b => !demoIds.has(Number(b.user_id)));
  state.transactions = state.transactions.filter(t => !demoIds.has(Number(t.user_id)));
}

function seedUser(username, displayName, role, password = 'password') {
  const exists = state.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return;

  const startingBalance = Math.ceil(Number(process.env.STARTING_BALANCE || 1000));
  const user = {
    id: state.nextUserId++,
    username,
    password_hash: bcrypt.hashSync(password, 10),
    display_name: displayName,
    role,
    balance: startingBalance,
    created_at: nowIso()
  };
  state.users.push(user);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: user.id,
    amount: startingBalance,
    kind: 'starting_balance',
    note: 'Initial season Mushybux',
    created_at: nowIso()
  });
}

export function authenticate(username, password) {
  const user = state.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return safeUser(user);
}

export function getUserById(id) {
  const user = state.users.find(u => u.id === Number(id));
  return user ? safeUser(user) : null;
}

export function getLeaderboard(currentWeek = null, includeCasino = true) {
  const weekNum = Number(currentWeek ?? state.settings?.currentWeek ?? 1);

  return state.users
    .map(user => {
      const openWagered = getOpenWageredForUser(user.id);
      const casinoNet = getCasinoNetForUser(user.id);
      const cardsNet = getCardsNetForUser(user.id);
      const overallBalance = Number(user.balance || 0) + openWagered;
      const totalBalance = includeCasino
        ? overallBalance
        : overallBalance - casinoNet - cardsNet;
      const lastWeekBettingChange = getSettledBetNetForUser(user.id, weekNum - 1);
      const currentWeekBettingChange = getSettledBetNetForUser(user.id, weekNum);
      return {
        id: user.id,
        display_name: user.display_name,
        username: user.username,
        balance: user.balance,
        open_wagered: openWagered,
        casino_net: casinoNet,
        cards_net: cardsNet,
        total_balance: totalBalance,
        balance_display: formatBalanceDisplay(totalBalance, openWagered),
        last_week_change: lastWeekBettingChange + (
          includeCasino
            ? getCasinoNetForUserWeek(user.id, weekNum - 1) + getCardsNetForUserWeek(user.id, weekNum - 1)
            : 0
        ),
        current_week_change: currentWeekBettingChange + (
          includeCasino
            ? getCasinoNetForUserWeek(user.id, weekNum) + getCardsNetForUserWeek(user.id, weekNum)
            : 0
        )
      };
    })
    .sort((a, b) => b.total_balance - a.total_balance || a.display_name.localeCompare(b.display_name));
}

function getCasinoNetForUser(userId) {
  return state.transactions
    .filter(transaction =>
      Number(transaction.user_id) === Number(userId) &&
      transaction.category === 'casino'
    )
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
}

function getCardsNetForUser(userId) {
  return state.transactions
    .filter(transaction =>
      Number(transaction.user_id) === Number(userId) &&
      transaction.category === 'cards'
    )
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
}

function getCasinoNetForUserWeek(userId, week) {
  const targetWeek = Number(week);
  if (!Number.isFinite(targetWeek) || targetWeek < 1) return 0;
  return state.transactions
    .filter(transaction =>
      Number(transaction.user_id) === Number(userId) &&
      transaction.category === 'casino' &&
      Number(transaction.week) === targetWeek
    )
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
}

function getCardsNetForUserWeek(userId, week) {
  const targetWeek = Number(week);
  if (!Number.isFinite(targetWeek) || targetWeek < 1) return 0;
  return state.transactions
    .filter(transaction =>
      Number(transaction.user_id) === Number(userId) &&
      transaction.category === 'cards' &&
      Number(transaction.week) === targetWeek
    )
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
}

function getSettledBetNetForUser(userId, week) {
  const targetWeek = Number(week);
  if (!Number.isFinite(targetWeek) || targetWeek < 1) return 0;

  return state.bets
    .filter(b =>
      Number(b.user_id) === Number(userId) &&
      Number(b.week) === targetWeek &&
      b.status === 'settled'
    )
    .reduce((sum, b) => sum + Number(b.payout || 0) - Number(b.stake || 0), 0);
}

export function getOpenWageredForUser(userId) {
  return state.bets
    .filter(b => b.user_id === Number(userId) && b.status === 'open')
    .reduce((sum, b) => sum + Number(b.stake || 0), 0);
}

export function getBalanceSummaryForUser(userId) {
  const user = state.users.find(u => u.id === Number(userId));
  if (!user) return { available_balance: 0, open_wagered: 0, total_balance: 0, display: '0 (0)' };
  const openWagered = getOpenWageredForUser(userId);
  const totalBalance = Number(user.balance || 0) + openWagered;
  return {
    available_balance: Number(user.balance || 0),
    open_wagered: openWagered,
    total_balance: totalBalance,
    display: formatBalanceDisplay(totalBalance, openWagered)
  };
}

function formatBalanceDisplay(totalBalance, openWagered) {
  return `${Number(totalBalance || 0)} (${Number(openWagered || 0)})`;
}

export function getUserBets(userId, limit = 20) {
  return state.bets
    .filter(b => b.user_id === Number(userId))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id)
    .slice(0, limit);
}

export function getUserBetsForWeek(userId, week) {
  return state.bets
    .filter(b => b.user_id === Number(userId) && Number(b.week) === Number(week))
    .sort((a, b) => String(a.series_key || a.prop_key || '').localeCompare(String(b.series_key || b.prop_key || '')));
}

export function getUserBetForSeries(userId, week, seriesKey) {
  return state.bets.find(b =>
    b.user_id === Number(userId) &&
    Number(b.week) === Number(week) &&
    (b.bet_kind || 'series') === 'series' &&
    b.series_key === seriesKey &&
    b.status === 'open'
  ) || null;
}

export function getUserBetsBySeries(userId, week) {
  const map = new Map();
  const visibleStatuses = new Set(['open', 'settled']);

  for (const bet of getUserBetsForWeek(userId, week)) {
    if (!visibleStatuses.has(String(bet.status || 'open'))) continue;
    if ((bet.bet_kind || 'series') !== 'series') continue;

    const existing = map.get(bet.series_key);
    // Prefer an open editable bet if one somehow exists; otherwise show the
    // settled result so completed matchups do not look like "no bet placed".
    if (!existing || existing.status !== 'open' || bet.status === 'open') {
      map.set(bet.series_key, bet);
    }
  }

  return Object.fromEntries(map);
}

export function getWeeklyBetTotalByTeam(week) {
  const totals = new Map();

  // Community odds should reflect that week's betting activity even after
  // completed series bets are settled. Exclude void/refund/deleted statuses,
  // but keep both open and settled series stakes in the odds pool.
  const oddsStatuses = new Set(['open', 'settled']);

  for (const bet of state.bets.filter(b =>
    Number(b.week) === Number(week) &&
    oddsStatuses.has(String(b.status || 'open')) &&
    (b.bet_kind || 'series') === 'series'
  )) {
    const current = totals.get(bet.team_id) || { team_id: bet.team_id, total_stake: 0, bet_count: 0 };
    current.total_stake += Number(bet.stake || 0);
    current.bet_count += 1;
    totals.set(bet.team_id, current);
  }
  return [...totals.values()].sort((a, b) => b.total_stake - a.total_stake);
}

export function getTopWeeklyBets(week, limit = 5) {
  const totals = new Map();
  for (const bet of state.bets.filter(b => Number(b.week) === Number(week) && ['open', 'settled'].includes(b.status))) {
    const key = bet.market_key || bet.label;
    const current = totals.get(key) || {
      market_key: key,
      label: bet.label,
      team_id: bet.team_id,
      total_stake: 0,
      bet_count: 0
    };
    current.total_stake += Number(bet.stake || 0);
    current.bet_count += 1;
    totals.set(key, current);
  }
  return [...totals.values()]
    .sort((a, b) => b.total_stake - a.total_stake || b.bet_count - a.bet_count)
    .slice(0, limit);
}

export function getWeeklyStakeForUser(userId, week, excludeBetId = null) {
  return state.bets
    .filter(b =>
      b.user_id === Number(userId) &&
      Number(b.week) === Number(week) &&
      b.status === 'open' &&
      (excludeBetId === null || b.id !== Number(excludeBetId))
    )
    .reduce((sum, b) => sum + Number(b.stake || 0), 0);
}


export function getUserBetForProp(userId, week, divisionId, category) {
  return state.bets.find(b =>
    b.user_id === Number(userId) &&
    Number(b.week) === Number(week) &&
    b.bet_kind === 'prop' &&
    b.division_id === divisionId &&
    b.prop_category === category &&
    b.status === 'open'
  ) || null;
}

export function getUserPropBetsByCategory(userId, week) {
  const map = new Map();
  const visibleStatuses = new Set(['open', 'settled']);

  for (const bet of getUserBetsForWeek(userId, week)) {
    if (!visibleStatuses.has(String(bet.status || 'open'))) continue;
    if (bet.bet_kind !== 'prop') continue;

    const key = `${bet.division_id}|${bet.prop_category}`;
    const existing = map.get(key);
    if (!existing || existing.status !== 'open' || bet.status === 'open') {
      map.set(key, bet);
    }
  }

  return Object.fromEntries(map);
}

export function placeOrUpdatePropBet({
  userId,
  week,
  divisionId,
  propKey,
  marketKey = '',
  category,
  playerKey,
  playerName,
  playerTeamId = '',
  seriesKey = '',
  propLine = null,
  label,
  stake,
  multiplier,
  quantity = null,
  locked = false
}) {
  if (locked) throw new Error('Betting is locked for this week.');

  stake = Number(stake);
  const maxBet = Number(process.env.PROP_MAX_BET || 100);
  if (!Number.isInteger(stake) || stake <= 0) throw new Error('Stake must be a positive whole number.');
  if (stake > maxBet) throw new Error(`Max prop bet is ${maxBet} Mushybux.`);

  const user = state.users.find(u => u.id === Number(userId));
  if (!user) throw new Error('User not found.');

  const existingBet = getUserBetForProp(userId, week, divisionId, category);
  const existingStake = existingBet ? Number(existingBet.stake || 0) : 0;
  const availableBalance = Number(user.balance || 0) + existingStake;

  if (availableBalance < stake) throw new Error('Insufficient balance.');

  if (existingBet) {
    user.balance = availableBalance - stake;
    existingBet.prop_key = propKey;
    existingBet.market_key = marketKey || propKey;
    existingBet.market_type = category;
    existingBet.prop_category = category;
    existingBet.player_key = playerKey;
    existingBet.player_name = playerName;
    existingBet.player_team_id = String(playerTeamId || existingBet.player_team_id || '');
    existingBet.series_key = String(seriesKey || '');
    existingBet.prop_line = propLine == null ? null : Number(propLine);
    existingBet.label = label;
    existingBet.stake = stake;
    existingBet.multiplier = Number(multiplier);
    existingBet.quantity = quantity == null ? null : Number(quantity);
    existingBet.updated_at = nowIso();

    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: Number(userId),
      bet_id: existingBet.id,
      amount: existingStake - stake,
      kind: 'prop_bet_change',
      note: label,
      created_at: nowIso()
    });

    saveState();
    return { id: existingBet.id, action: 'updated' };
  }

  user.balance -= stake;

  const bet = {
    id: state.nextBetId++,
    user_id: Number(userId),
    bet_kind: 'prop',
    week: Number(week),
    division_id: divisionId,
    series_key: String(seriesKey || ''),
    prop_key: propKey,
    prop_category: category,
    market_key: marketKey || propKey,
    market_type: category,
    team_id: '',
    player_key: playerKey,
    player_name: playerName,
    player_team_id: String(playerTeamId || ''),
    quantity: quantity == null ? null : Number(quantity),
    prop_line: propLine == null ? null : Number(propLine),
    label,
    stake,
    multiplier: Number(multiplier),
    goal_total_side: '',
    goal_total_line: null,
    goal_total_boost: null,
    status: 'open',
    payout: null,
    created_at: nowIso()
  };

  state.bets.push(bet);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    bet_id: bet.id,
    amount: -stake,
    kind: 'prop_bet_stake',
    note: label,
    created_at: nowIso()
  });

  saveState();
  return { id: bet.id, action: 'placed' };
}

export function placeOrUpdateBet({ userId, week, divisionId, seriesKey, marketKey, marketType, teamId, label, stake, multiplier, goalTotalSide = '', goalTotalLine = null, goalTotalBoost = null, locked = false }) {
  if (locked) throw new Error('Betting is locked for this week.');

  stake = Number(stake);
  const maxBet = Number(process.env.MAX_BET || 250);
  if (!Number.isInteger(stake) || stake <= 0) throw new Error('Stake must be a positive whole number.');
  if (stake > maxBet) throw new Error(`Max bet is ${maxBet} Mushybux.`);

  const user = state.users.find(u => u.id === Number(userId));
  if (!user) throw new Error('User not found.');

  const existingBet = getUserBetForSeries(userId, week, seriesKey);
  const existingStake = existingBet ? Number(existingBet.stake || 0) : 0;
  const availableBalance = Number(user.balance || 0) + existingStake;

  if (availableBalance < stake) throw new Error('Insufficient balance.');

  if (existingBet) {
    user.balance = availableBalance - stake;
    existingBet.division_id = divisionId;
    existingBet.market_key = marketKey;
    existingBet.market_type = marketType;
    existingBet.team_id = teamId;
    existingBet.label = label;
    existingBet.stake = stake;
    existingBet.multiplier = Number(multiplier);
    existingBet.goal_total_side = goalTotalSide || '';
    existingBet.goal_total_line = goalTotalLine == null ? null : Number(goalTotalLine);
    existingBet.goal_total_boost = goalTotalBoost == null ? null : Number(goalTotalBoost);
    existingBet.updated_at = nowIso();

    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: Number(userId),
      bet_id: existingBet.id,
      amount: existingStake - stake,
      kind: 'bet_change',
      note: label,
      created_at: nowIso()
    });

    saveState();
    return { id: existingBet.id, action: 'updated' };
  }

  user.balance -= stake;

  const bet = {
    id: state.nextBetId++,
    user_id: Number(userId),
    bet_kind: 'series',
    week: Number(week),
    division_id: divisionId,
    series_key: seriesKey,
    market_key: marketKey,
    market_type: marketType,
    team_id: teamId,
    label,
    stake,
    multiplier: Number(multiplier),
    goal_total_side: goalTotalSide || '',
    goal_total_line: goalTotalLine == null ? null : Number(goalTotalLine),
    goal_total_boost: goalTotalBoost == null ? null : Number(goalTotalBoost),
    status: 'open',
    payout: null,
    created_at: nowIso()
  };

  state.bets.push(bet);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    bet_id: bet.id,
    amount: -stake,
    kind: 'bet_stake',
    note: label,
    created_at: nowIso()
  });

  saveState();
  return { id: bet.id, action: 'placed' };
}

// Backwards-compatible name for any older code paths.
export function placeBet(args) {
  return placeOrUpdateBet(args).id;
}

export function cancelOpenBet({ userId, betId, locked = false }) {
  if (locked) throw new Error('Betting is locked for this week.');

  const index = state.bets.findIndex(b =>
    Number(b.id) === Number(betId) &&
    Number(b.user_id) === Number(userId)
  );
  if (index < 0) throw new Error('Bet not found.');

  const bet = state.bets[index];
  if (bet.status !== 'open') throw new Error('Only open bets can be cancelled.');
  if (isWeekLockedInternal(bet.week)) throw new Error('Betting is locked for this week.');

  const user = state.users.find(u => Number(u.id) === Number(userId));
  if (!user) throw new Error('User not found.');

  const refunded = Number(bet.stake || 0);
  user.balance = Number(user.balance || 0) + refunded;
  state.bets.splice(index, 1);

  const stakeKind = (bet.bet_kind || 'series') === 'prop' ? 'prop_bet_stake' : 'bet_stake';
  const changeKind = (bet.bet_kind || 'series') === 'prop' ? 'prop_bet_change' : 'bet_change';
  state.transactions = state.transactions.filter(t => {
    if (Number(t.bet_id) === Number(bet.id)) return false;

    // Older bets predate transaction-to-bet IDs. Remove only exact timestamp
    // matches so unrelated account history is never guessed at or discarded.
    const sameUser = Number(t.user_id) === Number(userId);
    const originalStake = sameUser && t.kind === stakeKind && t.created_at === bet.created_at;
    const latestChange = sameUser && t.kind === changeKind && bet.updated_at && t.created_at === bet.updated_at;
    return !originalStake && !latestChange;
  });

  saveState();
  return { id: bet.id, refunded, betKind: bet.bet_kind || 'series' };
}


function weekKey(week) {
  return String(Number(week));
}

function cleanMultiplier(value, label = 'Odds') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be greater than 0.`);
  return Number(n.toFixed(2));
}

function ensureOddsState() {
  ensureSettings();
  state.oddsAdjustments = {
    series: {},
    goalTotals: {},
    propDefaults: {},
    propPlayerOverrides: {},
    ...(state.oddsAdjustments || {})
  };
}

export function getOddsAdjustmentsForWeek(week) {
  ensureOddsState();
  const wk = weekKey(week);
  return {
    week: Number(week),
    series: { ...(state.oddsAdjustments.series[wk] || {}) },
    goalTotals: { ...(state.oddsAdjustments.goalTotals[wk] || {}) },
    propDefaults: { ...(state.oddsAdjustments.propDefaults[wk] || {}) },
    propPlayerOverrides: { ...(state.oddsAdjustments.propPlayerOverrides[wk] || {}) },
    seriesProps: { ...(state.oddsAdjustments.seriesProps[wk] || {}) }
  };
}

export function saveSeriesPropForWeek({ week, marketKey, config }) {
  ensureOddsState();
  const wk = weekKey(week);
  const key = String(marketKey || '').trim();
  if (!key) throw new Error('Series prop market key is required.');
  if (!state.oddsAdjustments.seriesProps[wk]) state.oddsAdjustments.seriesProps[wk] = {};

  const tiers = (Array.isArray(config?.tiers) ? config.tiers : []).map((tier, index) => ({
    quantity: index + 1,
    label: String(tier.label || '').trim(),
    line: cleanMultiplier(tier.line, 'Prop line'),
    multiplier: cleanMultiplier(tier.multiplier, 'Prop odds')
  }));
  if (tiers.length !== 3) throw new Error('All three prop tiers are required.');

  state.oddsAdjustments.seriesProps[wk][key] = {
    seriesKey: String(config.seriesKey || '').trim(),
    divisionId: String(config.divisionId || '').trim(),
    category: String(config.category || '').trim(),
    playerKey: String(config.playerKey || '').trim(),
    playerName: String(config.playerName || '').trim(),
    playerTeamId: String(config.playerTeamId || '').trim(),
    opponentTeamId: String(config.opponentTeamId || '').trim(),
    eligibility: String(config.eligibility || 'automatic').trim(),
    enabled: config.enabled !== false,
    tiers
  };
  repriceOpenSeriesPropBets(Number(week), key, state.oddsAdjustments.seriesProps[wk][key]);
  migrateLegacyShutoutBetsForWeek(Number(week));
  saveState();
  return getOddsAdjustmentsForWeek(week);
}

export function saveSeriesPropsForWeek({ week, markets }) {
  ensureOddsState();
  const wk = weekKey(week);
  if (!state.oddsAdjustments.seriesProps[wk]) state.oddsAdjustments.seriesProps[wk] = {};
  for (const market of markets || []) {
    const key = String(market.marketKey || '').trim();
    if (!key) continue;
    const tiers = (market.tiers || []).map((tier, index) => ({
      quantity: index + 1,
      label: String(tier.label || '').trim(),
      line: cleanMultiplier(tier.line, 'Prop line'),
      multiplier: cleanMultiplier(tier.multiplier, 'Prop odds')
    }));
    if (tiers.length !== 3) throw new Error('All three prop tiers are required.');
    state.oddsAdjustments.seriesProps[wk][key] = {
      seriesKey: String(market.seriesKey || '').trim(),
      divisionId: String(market.divisionId || '').trim(),
      category: String(market.category || '').trim(),
      playerKey: String(market.playerKey || '').trim(),
      playerName: String(market.playerName || '').trim(),
      playerTeamId: String(market.playerTeamId || '').trim(),
      opponentTeamId: String(market.opponentTeamId || '').trim(),
      eligibility: String(market.eligibility || 'automatic').trim(),
      enabled: market.enabled !== false,
      tiers
    };
    repriceOpenSeriesPropBets(Number(week), key, state.oddsAdjustments.seriesProps[wk][key]);
  }
  migrateLegacyShutoutBetsForWeek(Number(week));
  saveState();
  return getOddsAdjustmentsForWeek(week);
}

function repriceOpenSeriesPropBets(week, marketKey, market) {
  for (const bet of state.bets) {
    if (
      Number(bet.week) !== Number(week) ||
      bet.status !== 'open' ||
      bet.bet_kind !== 'prop' ||
      String(bet.market_key || '') !== String(marketKey)
    ) continue;
    const tier = market.tiers.find(item => Number(item.quantity) === Number(bet.quantity || 1));
    if (!tier) continue;
    bet.multiplier = Number(tier.multiplier);
    bet.prop_line = Number(tier.line);
    bet.label = `${market.divisionId} ${market.category === 'player_goals' ? 'Player Goals' : 'Goalie Shutouts'}: ${market.playerName} vs ${market.opponentTeamId} · ${tier.label}`;
    bet.odds_updated_at = nowIso();
  }
}

function migrateLegacyShutoutBetsForWeek(week) {
  const wk = weekKey(week);
  const markets = Object.entries(state.oddsAdjustments.seriesProps[wk] || {})
    .filter(([, market]) => market.category === 'shutout' && market.enabled !== false);
  for (const bet of state.bets) {
    if (
      Number(bet.week) !== Number(week) ||
      bet.status !== 'open' ||
      bet.prop_category !== 'shutout' ||
      String(bet.series_key || '')
    ) continue;
    const matching = markets.filter(([, market]) => market.playerKey === bet.player_key);
    if (matching.length !== 1) continue;
    const [key, market] = matching[0];
    const tier = market.tiers.find(item => Number(item.quantity) === Number(bet.quantity || 1));
    if (!tier) continue;
    bet.series_key = market.seriesKey;
    bet.market_key = key;
    bet.multiplier = Number(tier.multiplier);
    bet.prop_line = Number(tier.line);
    bet.label = `${market.divisionId} Goalie Shutouts: ${market.playerName} vs ${market.opponentTeamId} · ${tier.label}`;
    bet.odds_updated_at = nowIso();
  }
}

export function getAllOddsAdjustmentsForWeek(week) {
  return getOddsAdjustmentsForWeek(week);
}

export function saveSeriesOddsForWeek({ week, marketKeys = [], multipliers = [], seriesKey, goalTotalLine, goalTotalBoost }) {
  ensureOddsState();
  const wk = weekKey(week);
  if (!state.oddsAdjustments.series[wk]) state.oddsAdjustments.series[wk] = {};
  if (!state.oddsAdjustments.goalTotals[wk]) state.oddsAdjustments.goalTotals[wk] = {};

  const keys = Array.isArray(marketKeys) ? marketKeys : [marketKeys];
  const vals = Array.isArray(multipliers) ? multipliers : [multipliers];
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || '').trim();
    if (!key) continue;
    state.oddsAdjustments.series[wk][key] = cleanMultiplier(vals[i], 'Series odds');
  }

  const cleanSeriesKey = String(seriesKey || '').trim();
  if (cleanSeriesKey) {
    const line = cleanMultiplier(goalTotalLine, 'O/U line');
    const boost = cleanMultiplier(goalTotalBoost, 'O/U boost');
    state.oddsAdjustments.goalTotals[wk][cleanSeriesKey] = { line, boost };

    const savedSeriesOdds = state.oddsAdjustments.series[wk];
    for (const bet of state.bets) {
      if (
        Number(bet.week) !== Number(week) ||
        bet.status !== 'open' ||
        (bet.bet_kind || 'series') !== 'series' ||
        String(bet.series_key || '') !== cleanSeriesKey
      ) continue;

      const baseMultiplier = savedSeriesOdds[bet.market_key];
      if (baseMultiplier == null) continue;
      bet.multiplier = Number((
        Number(baseMultiplier) * (bet.goal_total_side ? boost : 1)
      ).toFixed(2));
      if (bet.goal_total_side) {
        bet.goal_total_line = line;
        bet.goal_total_boost = boost;
        const side = bet.goal_total_side === 'over' ? 'Over' : 'Under';
        bet.label = String(bet.label || '').replace(
          / \+ (Over|Under) [\d.]+$/,
          ` + ${side} ${line}`
        );
      }
      bet.odds_updated_at = nowIso();
    }
  }

  saveState();
  return getOddsAdjustmentsForWeek(week);
}

export function savePropDefaultOddsForWeek({ week, divisionId, category, multiplier, quantity1, quantity2, quantity3 }) {
  ensureOddsState();
  const wk = weekKey(week);
  if (!state.oddsAdjustments.propDefaults[wk]) state.oddsAdjustments.propDefaults[wk] = {};
  const prefix = `${divisionId}|${category}`;

  if (category === 'top_scorer' || category === 'top_goalie') {
    state.oddsAdjustments.propDefaults[wk][prefix] = cleanMultiplier(multiplier, 'Prop odds');
  } else {
    state.oddsAdjustments.propDefaults[wk][`${prefix}|1`] = cleanMultiplier(quantity1, '1-result odds');
    state.oddsAdjustments.propDefaults[wk][`${prefix}|2`] = cleanMultiplier(quantity2, '2-result odds');
    state.oddsAdjustments.propDefaults[wk][`${prefix}|3`] = cleanMultiplier(quantity3, '3-result odds');
  }

  for (const bet of state.bets) {
    if (
      Number(bet.week) !== Number(week) ||
      bet.status !== 'open' ||
      bet.bet_kind !== 'prop' ||
      bet.division_id !== divisionId ||
      bet.prop_category !== category
    ) continue;
    const quantity = Number(bet.quantity || 0);
    const key = quantity
      ? `${prefix}|${quantity}`
      : prefix;
    const overrideKey = quantity
      ? `${prefix}|${bet.player_key}|${quantity}`
      : `${prefix}|${bet.player_key}`;
    const value = state.oddsAdjustments.propPlayerOverrides[wk]?.[overrideKey]
      ?? state.oddsAdjustments.propDefaults[wk][key];
    if (value != null) {
      bet.multiplier = Number(value);
      bet.odds_updated_at = nowIso();
    }
  }

  saveState();
  return getOddsAdjustmentsForWeek(week);
}

export function savePropPlayerOverrideForWeek({ week, divisionId, category, playerKey, multiplier, quantity = null }) {
  ensureOddsState();
  const wk = weekKey(week);
  if (!state.oddsAdjustments.propPlayerOverrides[wk]) state.oddsAdjustments.propPlayerOverrides[wk] = {};
  const baseKey = `${divisionId}|${category}|${playerKey}`;
  const key = quantity == null || quantity === '' ? baseKey : `${baseKey}|${Number(quantity)}`;
  const value = String(multiplier ?? '').trim();
  if (!value) delete state.oddsAdjustments.propPlayerOverrides[wk][key];
  else state.oddsAdjustments.propPlayerOverrides[wk][key] = cleanMultiplier(value, 'Player override odds');
  if (value) {
    for (const bet of state.bets) {
      if (
        Number(bet.week) === Number(week) &&
        bet.status === 'open' &&
        bet.bet_kind === 'prop' &&
        bet.division_id === divisionId &&
        bet.prop_category === category &&
        bet.player_key === playerKey &&
        (quantity == null || quantity === '' || Number(bet.quantity) === Number(quantity))
      ) {
        bet.multiplier = state.oddsAdjustments.propPlayerOverrides[wk][key];
        bet.odds_updated_at = nowIso();
      }
    }
  }
  saveState();
  return getOddsAdjustmentsForWeek(week);
}

export function clearPropPlayerOverrideForWeek({ week, divisionId, category, playerKey, quantity = null }) {
  ensureOddsState();
  const wk = weekKey(week);
  const baseKey = `${divisionId}|${category}|${playerKey}`;
  if (state.oddsAdjustments.propPlayerOverrides[wk]) {
    if (quantity == null || quantity === '') {
      delete state.oddsAdjustments.propPlayerOverrides[wk][baseKey];
      for (const q of [1, 2, 3]) delete state.oddsAdjustments.propPlayerOverrides[wk][`${baseKey}|${q}`];
    } else {
      delete state.oddsAdjustments.propPlayerOverrides[wk][`${baseKey}|${Number(quantity)}`];
    }
  }
  saveState();
  return getOddsAdjustmentsForWeek(week);
}

export function setSeasonId(seasonId) {
  const cleanSeasonId = String(seasonId || '').trim();
  if (!cleanSeasonId) throw new Error('Season is required.');
  ensureSettings();
  state.settings.seasonId = cleanSeasonId;
  state.settings.currentWeek = 1;
  state.settings.lockedWeeks = [];
  state.settings.bettingLocked = false;
  saveState();
  return getAdminSettings();
}

function settleBetsInternal({ week, results, requireReady = false }) {
  const targetWeek = Number(week);
  if (!Number.isFinite(targetWeek) || targetWeek < 1) throw new Error('Invalid week.');

  const openBets = state.bets.filter(b => Number(b.week) === targetWeek && b.status === 'open');
  if (!openBets.length) return { settled: 0, winners: 0, losers: 0, payoutTotal: 0, skipped: 0 };

  let settled = 0;
  let winners = 0;
  let losers = 0;
  let skipped = 0;
  let payoutTotal = 0;

  for (const bet of openBets) {
    const evaluation = results.evaluations?.[bet.id];
    if (!evaluation || !evaluation.ready) {
      skipped += 1;
      continue;
    }

    const payout = evaluation.won ? Math.ceil(Number(bet.stake || 0) * Number(bet.multiplier || 0)) : 0;
    const user = state.users.find(u => u.id === Number(bet.user_id));
    if (user && payout > 0) user.balance = Number(user.balance || 0) + payout;

    bet.status = 'settled';
    bet.settled_at = nowIso();
    bet.payout = payout;
    bet.won = Boolean(evaluation.won);
    bet.result_summary = evaluation.result_summary || evaluation.reason || '';

    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: Number(bet.user_id),
      week: targetWeek,
      amount: payout,
      kind: evaluation.won ? 'bet_payout' : 'bet_loss',
      note: `${evaluation.won ? 'Won' : 'Lost'}: ${bet.label}${evaluation.result_summary ? ` (${evaluation.result_summary})` : ''}`,
      created_at: nowIso()
    });

    settled += 1;
    if (evaluation.won) winners += 1;
    else losers += 1;
    payoutTotal += payout;
  }

  if (requireReady && skipped > 0) throw new Error(`Week ${targetWeek} still has ${skipped} incomplete bet(s).`);

  saveState();
  return { settled, winners, losers, payoutTotal, skipped };
}

export function settleWeek({ week, results }) {
  return settleBetsInternal({ week, results, requireReady: false });
}

export function settleCompletedBets({ week, results }) {
  return settleBetsInternal({ week, results, requireReady: false });
}

export function buildSettlementPreview({ week, weekResults, evaluator }) {
  const targetWeek = Number(week);
  const usersById = new Map(state.users.map(u => [u.id, u]));
  const rows = state.bets
    .filter(b => Number(b.week) === targetWeek && b.status === 'open')
    .map(b => {
      const evaluation = evaluator(b, weekResults);
      const payout = evaluation.ready && evaluation.won ? Math.ceil(Number(b.stake || 0) * Number(b.multiplier || 0)) : 0;
      const user = usersById.get(Number(b.user_id));
      return {
        ...b,
        user_display_name: user?.display_name || `User ${b.user_id}`,
        ready: evaluation.ready,
        won: evaluation.won,
        evaluation_reason: evaluation.reason,
        result_summary: evaluation.result_summary || '',
        payout
      };
    });

  return {
    week: targetWeek,
    rows,
    ready: rows.every(r => r.ready),
    winners: rows.filter(r => r.ready && r.won).length,
    losers: rows.filter(r => r.ready && !r.won).length,
    skipped: rows.filter(r => !r.ready).length,
    payoutTotal: rows.reduce((sum, r) => sum + Number(r.payout || 0), 0)
  };
}


export function getAdminSettings() {
  ensureSettings();
  return {
    ...state.settings,
    currentWeekLocked: isWeekLockedInternal(state.settings.currentWeek),
    nextWeekLocked: isWeekLockedInternal(Number(state.settings.currentWeek) + 1)
  };
}

export function isWeekLocked(week) {
  ensureSettings();
  return isWeekLockedInternal(week);
}

export function setWeekLocked(week, locked) {
  setWeekLockedInternal(week, locked);
  saveState();
  return getAdminSettings();
}

export function setBettingLocked(locked) {
  ensureSettings();
  setWeekLockedInternal(state.settings.currentWeek, locked);
  saveState();
  return getAdminSettings();
}

export function setWeeklyAllowance(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new Error('Weekly allowance must be 0 or more.');
  ensureSettings();
  state.settings.weeklyAllowance = Math.floor(value);
  saveState();
  return getAdminSettings();
}

export function setCasinoOpen(open) {
  ensureSettings();
  state.settings.casinoOpen = Boolean(open);
  saveState();
  return getAdminSettings();
}

export function setCasinoLinkVisible(visible) {
  ensureSettings();
  state.settings.casinoLinkVisible = Boolean(visible);
  saveState();
  return getAdminSettings();
}

export function setCardsOpen(open) {
  ensureSettings();
  state.settings.cardsOpen = Boolean(open);
  if (state.settings.cardsOpen) {
    ensureCardsState();
    state.cards.arena.lastMatchmakingHour = arenaHourKey(new Date());
  }
  saveState();
  return getAdminSettings();
}

export function applyWeeklyAllowance(week = null) {
  ensureSettings();
  const amount = Number(state.settings.weeklyAllowance || 0);
  const targetWeek = Number(week || state.settings.currentWeek);
  if (amount <= 0) return { amount, count: 0 };

  let count = 0;
  for (const user of state.users) {
    const alreadyApplied = state.transactions.some(t =>
      t.user_id === user.id &&
      t.kind === 'weekly_allowance' &&
      Number(t.week) === targetWeek
    );
    if (alreadyApplied) continue;

    user.balance = Number(user.balance || 0) + amount;
    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: user.id,
      week: targetWeek,
      amount,
      kind: 'weekly_allowance',
      note: `Week ${targetWeek} allowance`,
      created_at: nowIso()
    });
    count += 1;
  }

  saveState();
  return { amount, count };
}

export function advanceWeek() {
  ensureSettings();
  state.settings.currentWeek = Number(state.settings.currentWeek || 1) + 1;

  // Reviewed odds become the new current week and betting opens.
  setWeekLockedInternal(state.settings.currentWeek, false);
  setWeekLockedInternal(Number(state.settings.currentWeek) + 1, false);

  saveState();
  return getAdminSettings();
}

export function getAdminBetsForWeek(week, statuses = ['open']) {
  const usersById = new Map(state.users.map(u => [u.id, u]));
  const visibleStatuses = new Set(
    (Array.isArray(statuses) ? statuses : [statuses]).map(status => String(status))
  );
  return state.bets
    .filter(b =>
      Number(b.week) === Number(week) &&
      visibleStatuses.has(String(b.status || 'open'))
    )
    .map(b => {
      const user = usersById.get(Number(b.user_id));
      return {
        ...b,
        user_display_name: user?.display_name || `User ${b.user_id}`,
        potential_return: Math.ceil(Number(b.stake || 0) * Number(b.multiplier || 0))
      };
    })
    .sort((a, b) =>
      String(a.bet_kind || '').localeCompare(String(b.bet_kind || '')) ||
      String(a.division_id || '').localeCompare(String(b.division_id || '')) ||
      String(a.label || '').localeCompare(String(b.label || '')) ||
      String(a.user_display_name || '').localeCompare(String(b.user_display_name || ''))
    );
}

export function getUserSummaries() {
  return state.users
    .map(user => {
      const openWagered = getOpenWageredForUser(user.id);
      const totalBalance = Number(user.balance || 0) + openWagered;
      return {
        id: user.id,
        display_name: user.display_name,
        username: user.username,
        role: user.role,
        available_balance: Number(user.balance || 0),
        open_wagered: openWagered,
        total_balance: totalBalance,
        balance_display: formatBalanceDisplay(totalBalance, openWagered)
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}


export function adjustUserBalance(userId, amount, note = '') {
  const value = Number(amount);
  if (!Number.isInteger(value) || value === 0) throw new Error('Balance adjustment must be a non-zero whole number.');

  const user = state.users.find(u => u.id === Number(userId));
  if (!user) throw new Error('User not found.');

  user.balance = Number(user.balance || 0) + value;

  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: user.id,
    amount: value,
    kind: 'admin_balance_adjustment',
    note: note ? `Admin adjustment: ${note}` : 'Admin balance adjustment',
    created_at: nowIso()
  });

  saveState();
  return getBalanceSummaryForUser(user.id);
}

export function adjustAllUserBalances(amount, note = '') {
  const value = Number(amount);
  if (!Number.isInteger(value) || value === 0) {
    throw new Error('Bulk balance adjustment must be a non-zero whole number.');
  }

  const cleanNote = String(note || '').trim();
  for (const user of state.users) {
    user.balance = Number(user.balance || 0) + value;
    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: user.id,
      amount: value,
      kind: 'admin_bulk_balance_adjustment',
      note: cleanNote
        ? `Bulk admin adjustment: ${cleanNote}`
        : 'Bulk admin balance adjustment',
      created_at: nowIso()
    });
  }

  saveState();
  return { amount: value, count: state.users.length };
}


export function addUser({ username, password, displayName = '', role = 'user' }) {
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '').trim();
  const cleanDisplayName = String(displayName || cleanUsername).trim();
  const cleanRole = String(role || 'user').trim().toLowerCase() === 'admin' ? 'admin' : 'user';

  if (!cleanUsername) throw new Error('Username is required.');
  if (!cleanPassword) throw new Error('Password is required.');
  if (state.users.some(u => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
    throw new Error('Username already exists.');
  }

  const startingBalance = Math.ceil(Number(process.env.STARTING_BALANCE || 1000));
  const user = {
    id: state.nextUserId++,
    username: cleanUsername,
    password_hash: bcrypt.hashSync(cleanPassword, 10),
    display_name: cleanDisplayName,
    role: cleanRole,
    balance: startingBalance,
    created_at: nowIso()
  };
  state.users.push(user);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: user.id,
    amount: startingBalance,
    kind: 'starting_balance',
    note: 'Initial season Mushybux',
    created_at: nowIso()
  });
  saveState();
  return safeUser(user);
}

export function updateUserDetails({ userId, username, password = '', displayName = '', role = 'user' }) {
  const user = state.users.find(u => u.id === Number(userId));
  if (!user) throw new Error('User not found.');

  const cleanUsername = String(username || '').trim();
  const cleanDisplayName = String(displayName || cleanUsername).trim();
  const cleanRole = String(role || 'user').trim().toLowerCase() === 'admin' ? 'admin' : 'user';

  if (!cleanUsername) throw new Error('Username is required.');
  const duplicate = state.users.find(u => u.id !== user.id && u.username.toLowerCase() === cleanUsername.toLowerCase());
  if (duplicate) throw new Error('Username already exists.');

  user.username = cleanUsername;
  user.display_name = cleanDisplayName || cleanUsername;
  user.role = cleanRole;

  const cleanPassword = String(password || '').trim();
  if (cleanPassword) user.password_hash = bcrypt.hashSync(cleanPassword, 10);

  saveState();
  return safeUser(user);
}

export function resetBetsForWeek(week) {
  const targetWeek = Number(week);
  let count = 0;
  let refunded = 0;

  for (const bet of state.bets) {
    if (Number(bet.week) !== targetWeek || bet.status !== 'open') continue;

    const result = voidOpenBet(bet, 'Voided bet refund');
    count += result.count;
    refunded += result.refunded;
  }

  saveState();
  return { count, refunded };
}


function voidOpenBet(bet, reason = 'Manual refund') {
  if (!bet || bet.status !== 'open') return { count: 0, refunded: 0 };
  const user = state.users.find(u => u.id === Number(bet.user_id));
  const stake = Number(bet.stake || 0);
  if (user) {
    user.balance = Number(user.balance || 0) + stake;
    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: user.id,
      week: Number(bet.week || 0),
      amount: stake,
      kind: 'bet_void_refund',
      note: `${reason}: ${bet.label}`,
      bet_id: bet.id,
      created_at: nowIso()
    });
  }

  bet.status = 'void';
  bet.voided_at = nowIso();
  bet.void_reason = reason;
  bet.payout = 0;
  return { count: 1, refunded: stake };
}

export function voidBetById(betId, reason = 'Manual refund') {
  const bet = state.bets.find(b => b.id === Number(betId));
  if (!bet) throw new Error('Bet not found.');
  if (bet.status !== 'open') throw new Error('Only open bets can be refunded.');
  const result = voidOpenBet(bet, reason);
  saveState();
  return result;
}

export function voidDeprecatedHatTrickBetsForWeek(week) {
  const targetWeek = Number(week);
  let count = 0;
  let refunded = 0;
  for (const bet of state.bets) {
    if (
      Number(bet.week) !== targetWeek ||
      bet.status !== 'open' ||
      bet.bet_kind !== 'prop' ||
      bet.prop_category !== 'hat_trick'
    ) continue;
    const result = voidOpenBet(bet, 'Hat trick market retired');
    count += result.count;
    refunded += result.refunded;
  }
  saveState();
  return { count, refunded };
}

export function voidBetsForSeries({ week, seriesKey, teamIds = [], playerKeys = [], reason = 'Postponed series refund' }) {
  const targetWeek = Number(week);
  const cleanSeriesKey = String(seriesKey || '').trim();
  const teamSet = new Set((Array.isArray(teamIds) ? teamIds : [teamIds]).map(v => String(v || '').trim()).filter(Boolean));
  const playerSet = new Set((Array.isArray(playerKeys) ? playerKeys : [playerKeys]).map(v => String(v || '').trim()).filter(Boolean));
  if (!targetWeek || !cleanSeriesKey) throw new Error('Week and series are required.');
  if (!teamSet.size) throw new Error('Series team IDs are required.');

  let count = 0;
  let refunded = 0;
  let seriesCount = 0;
  let propCount = 0;

  for (const bet of state.bets) {
    if (Number(bet.week) !== targetWeek || bet.status !== 'open') continue;

    const isSeriesBet = (bet.bet_kind || 'series') === 'series' && bet.series_key === cleanSeriesKey;
    const isTeamProp = bet.bet_kind === 'prop' && (
      String(bet.series_key || '').trim()
        ? String(bet.series_key || '').trim() === cleanSeriesKey
        : teamSet.has(String(bet.player_team_id || '').trim()) || playerSet.has(String(bet.player_key || '').trim())
    );
    if (!isSeriesBet && !isTeamProp) continue;

    const result = voidOpenBet(bet, reason);
    count += result.count;
    refunded += result.refunded;
    if (isSeriesBet) seriesCount += 1;
    if (isTeamProp) propCount += 1;
  }

  saveState();
  return { count, refunded, seriesCount, propCount };
}

export function getVoidRefundsForWeek(week, limit = 100) {
  const usersById = new Map(state.users.map(u => [u.id, u]));
  return state.transactions
    .filter(t => t.kind === 'bet_void_refund' && Number(t.week) === Number(week))
    .map(t => ({
      ...t,
      user_display_name: usersById.get(Number(t.user_id))?.display_name || `User ${t.user_id}`
    }))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id))
    .slice(0, limit);
}

export function getOpenBetCountForWeek(week) {
  return state.bets.filter(b => Number(b.week) === Number(week) && b.status === 'open').length;
}

export function resetAllData() {
  state = defaultState();
  ensureSettings();
  seedUser('Sundin', 'Sundin', 'admin', 'cactusgoat13');
  saveState();
  return getAdminSettings();
}

const CARD_LINEUP_SLOTS = ['F1', 'F2', 'D1', 'D2', 'G'];

export function getCardsConfig() {
  ensureCardsState();
  return JSON.parse(JSON.stringify(state.cards.config));
}

const configuredWutJoinFee = Number(process.env.WUT_JOIN_FEE || 100);
const WUT_JOIN_FEE = Number.isFinite(configuredWutJoinFee)
  ? Math.max(1, Math.ceil(configuredWutJoinFee))
  : 100;

export function getWutMembershipState(userId) {
  ensureCardsState();
  const membership = state.cards.wutMemberships.find(item => Number(item.user_id) === Number(userId));
  return {
    joined: Boolean(membership),
    starterOpened: Boolean(membership?.starter_opened_at),
    joinFee: Number(membership?.join_fee || WUT_JOIN_FEE),
    joinedAt: membership?.joined_at || null,
    starterOpenedAt: membership?.starter_opened_at || null,
    starterCardIds: [...(membership?.starter_card_ids || [])]
  };
}

export function joinWut(userId) {
  ensureCardsState();
  if (state.cards.wutMemberships.some(item => Number(item.user_id) === Number(userId))) {
    throw new Error('You have already joined WUT.');
  }
  const user = state.users.find(item => Number(item.id) === Number(userId));
  if (!user) throw new Error('User not found.');
  if (Number(user.balance || 0) < WUT_JOIN_FEE) throw new Error('Insufficient balance.');

  user.balance = Number(user.balance || 0) - WUT_JOIN_FEE;
  const membership = {
    user_id: Number(userId),
    join_fee: WUT_JOIN_FEE,
    joined_at: nowIso(),
    starter_opened_at: null,
    starter_card_ids: []
  };
  state.cards.wutMemberships.push(membership);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    week: Number(state.settings.currentWeek || 1),
    amount: -WUT_JOIN_FEE,
    kind: 'wut_membership',
    category: 'cards',
    note: 'Joined WUT',
    created_at: nowIso()
  });
  saveState();
  return getWutMembershipState(userId);
}

export function getCardsAdminState() {
  ensureCardsState();
  return {
    config: getCardsConfig(),
    positionOverrides: { ...state.cards.positionOverrides },
    tierOverrides: { ...state.cards.tierOverrides },
    calculatedTiers: { ...state.cards.calculatedTiers },
    totals: {
      ownedCards: state.cards.ownedCards.length,
      ownedBoosts: state.cards.ownedBoosts.length,
      packs: state.cards.packPurchases.length,
      queuedArenaEntries: state.cards.arena.entries.filter(entry => entry.status === 'queued').length,
      activeArenaMatches: state.cards.arena.matches.filter(match => match.status === 'active').length
    }
  };
}

function cleanPositiveConfigNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be 0 or more.`);
  return parsed;
}

export function saveCardsConfig(config) {
  ensureCardsState();
  const cleanGroup = (group, labels) => Object.fromEntries(
    labels.map(key => [
      key,
      cleanPositiveConfigNumber(config?.[group]?.[key], `${group} ${key}`)
    ])
  );
  const packTypes = ['standard', 'premium', 'prestige'];
  const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  const cleanOddsByPack = group => Object.fromEntries(packTypes.map(packType => [
    packType,
    Object.fromEntries(rarities.map(rarity => [
      rarity,
      cleanPositiveConfigNumber(
        config?.[group]?.[packType]?.[rarity],
        `${group} ${packType} ${rarity}`
      )
    ]))
  ]));
  const boostTypes = ['goal', 'assist', 'shot', 'hit', 'block', 'save', 'shutout'];
  const boostRarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const boostEffects = Object.fromEntries(boostTypes.map(type => [type, Object.fromEntries(boostRarities.map(rarity => [
    rarity,
    {
      per: Math.max(1, cleanPositiveConfigNumber(config?.boostEffects?.[type]?.[rarity]?.per ?? state.cards.config.boostEffects?.[type]?.[rarity]?.per, `${type} ${rarity} boost interval`)),
      bonus: cleanPositiveConfigNumber(config?.boostEffects?.[type]?.[rarity]?.bonus ?? state.cards.config.boostEffects?.[type]?.[rarity]?.bonus, `${type} ${rarity} boost bonus`)
    }
  ]))]));
  const statTypes = ['goal', 'assist', 'shot', 'hit', 'block', 'save', 'shutout'];
  const statPoints = Object.fromEntries(statTypes.map(type => [
    type,
    cleanPositiveConfigNumber(
      config?.scoring?.statPoints?.[type] ?? state.cards.config.scoring.statPoints[type],
      `${type} fantasy points`
    )
  ]));
  const rawSavePctBonuses = config?.scoring?.savePctBonuses;
  const submittedSavePctBonuses = Array.isArray(rawSavePctBonuses)
    ? rawSavePctBonuses
    : rawSavePctBonuses && typeof rawSavePctBonuses === 'object'
      ? Object.keys(rawSavePctBonuses).sort((a, b) => Number(a) - Number(b)).map(key => rawSavePctBonuses[key])
      : state.cards.config.scoring.savePctBonuses;
  if (!submittedSavePctBonuses.length) throw new Error('At least one save percentage threshold is required.');
  const savePctBonuses = submittedSavePctBonuses.map((row, index) => {
    const threshold = cleanPositiveConfigNumber(row?.threshold, `Save percentage threshold ${index + 1}`);
    const multiplier = cleanPositiveConfigNumber(row?.multiplier, `Save percentage multiplier ${index + 1}`);
    if (threshold > 1) throw new Error('Save percentage thresholds cannot exceed 1.000.');
    return { threshold, multiplier };
  }).sort((a, b) => a.threshold - b.threshold);
  if (savePctBonuses.some((row, index) => index > 0 && row.threshold <= savePctBonuses[index - 1].threshold)) {
    throw new Error('Save percentage thresholds must be unique.');
  }
  const chemistryBonuses = Object.fromEntries(['2', '3', '4', '5'].map(count => [
    count,
    cleanPositiveConfigNumber(
      config?.scoring?.chemistryBonuses?.[count] ?? state.cards.config.scoring.chemistryBonuses[count],
      `${count}-player chemistry bonus`
    )
  ]));
  const next = {
    playerPackPrices: cleanGroup('playerPackPrices', packTypes),
    boostPackPrices: cleanGroup('boostPackPrices', packTypes),
    playerTierOdds: cleanOddsByPack('playerTierOdds'),
    boostRarityOdds: cleanOddsByPack('boostRarityOdds'),
    boostEffects,
    scoring: { statPoints, savePctBonuses, chemistryBonuses }
  };
  for (const group of ['playerTierOdds', 'boostRarityOdds']) {
    for (const packType of packTypes) {
      if (Object.values(next[group][packType]).reduce((sum, value) => sum + value, 0) <= 0) {
        throw new Error(`${group} ${packType} must contain at least one positive weight.`);
      }
    }
  }
  state.cards.config = next;
  saveState();
  return getCardsConfig();
}

export function setCardsLinkVisible(visible) {
  ensureSettings();
  state.settings.cardsLinkVisible = Boolean(visible);
  saveState();
  return getAdminSettings();
}

export function setCardsAllowRetroactiveAssignment(allowed) {
  ensureSettings();
  state.settings.cardsAllowRetroactiveAssignment = Boolean(allowed);
  saveState();
  return getAdminSettings();
}

export function setCardsPositionOverride(catalogKey, position) {
  ensureCardsState();
  const key = String(catalogKey || '').trim();
  const cleanPosition = String(position || '').trim().toUpperCase();
  if (!key) throw new Error('Player is required.');
  if (!['', 'F', 'D', 'G'].includes(cleanPosition)) throw new Error('Invalid card position.');
  if (cleanPosition) state.cards.positionOverrides[key] = cleanPosition;
  else delete state.cards.positionOverrides[key];
  saveState();
  return { ...state.cards.positionOverrides };
}

export function setCardsTierOverride(catalogKey, tier) {
  ensureCardsState();
  const key = String(catalogKey || '').trim();
  const cleanTier = String(tier || '').trim().toLowerCase();
  if (!key) throw new Error('Player is required.');
  if (!['', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].includes(cleanTier)) {
    throw new Error('Invalid card tier.');
  }
  if (cleanTier) state.cards.tierOverrides[key] = cleanTier;
  else delete state.cards.tierOverrides[key];
  saveState();
  return { ...state.cards.tierOverrides };
}

export function setCardsPlayerOverrides({ positions = {}, tiers = {} }) {
  ensureCardsState();
  const nextPositions = {};
  const nextTiers = {};
  for (const [catalogKey, position] of Object.entries(positions || {})) {
    const key = String(catalogKey || '').trim();
    const rawPosition = Array.isArray(position) ? position.at(-1) : position;
    const cleanPosition = String(rawPosition || '').trim().toUpperCase();
    if (!key || !['', 'F', 'D', 'G'].includes(cleanPosition)) throw new Error('Invalid card position override.');
    if (cleanPosition) nextPositions[key] = cleanPosition;
  }
  for (const [catalogKey, tier] of Object.entries(tiers || {})) {
    const key = String(catalogKey || '').trim();
    const rawTier = Array.isArray(tier) ? tier.at(-1) : tier;
    const cleanTier = String(rawTier || '').trim().toLowerCase();
    if (!key || !['', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].includes(cleanTier)) {
      throw new Error('Invalid card rarity override.');
    }
    if (cleanTier) nextTiers[key] = cleanTier;
  }
  state.cards.positionOverrides = nextPositions;
  state.cards.tierOverrides = nextTiers;
  saveState();
  return { positions: { ...nextPositions }, tiers: { ...nextTiers } };
}

export function saveCalculatedCardTiers(catalog) {
  ensureCardsState();
  state.cards.calculatedTiers = Object.fromEntries(
    (catalog || []).map(player => [player.catalogKey, {
      tier: player.tier,
      position: player.position,
      weightedFpPerGame: Number(player.weightedFpPerGame || 0),
      updatedAt: nowIso()
    }])
  );
  saveState();
  return { ...state.cards.calculatedTiers };
}

export function getCardsOwnedState(userId) {
  ensureCardsState();
  return {
    cards: state.cards.ownedCards
      .filter(card => Number(card.user_id) === Number(userId))
      .map(card => ({ ...card })),
    boosts: state.cards.ownedBoosts
      .filter(boost => Number(boost.user_id) === Number(userId))
      .map(boost => ({ ...boost }))
  };
}

const ARENA_TURN_SEQUENCE = [1, 2, 2, 2, 2, 1];
const ARENA_COOLDOWNS = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
const ARENA_RARITY_RANK = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6 };

function arenaLocalDateKey(date = new Date(), timeZone = null) {
  const zone = timeZone || state.cards?.arena?.config?.timeZone || 'America/Los_Angeles';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function arenaHourKey(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

function nextArenaMatchmakingAt(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

function ensureArenaState() {
  ensureCardsState();
}

function activeArenaMatchesForUser(userId) {
  return state.cards.arena.matches.filter(match =>
    ['active', 'scoring'].includes(match.status) && match.player_ids.map(Number).includes(Number(userId))
  );
}

function arenaOpponent(match, userId) {
  return match.player_ids.find(id => Number(id) !== Number(userId));
}

function arenaCurrentPlayerId(match) {
  const first = Number(match.first_player_id);
  const second = Number(match.player_ids.find(id => Number(id) !== first));
  return Number(match.turn_index) % 2 === 0 ? first : second;
}

function publicArenaMatch(match, userId) {
  const players = match.player_ids.map(id => {
    const user = state.users.find(item => Number(item.id) === Number(id));
    return { id: Number(id), displayName: user?.display_name || user?.username || `Player ${id}` };
  });
  return {
    ...JSON.parse(JSON.stringify(match)),
    players,
    opponent: players.find(player => Number(player.id) !== Number(userId)) || null,
    current_player_id: match.status === 'active' ? arenaCurrentPlayerId(match) : null,
    cards_required_this_turn: match.status === 'active' ? ARENA_TURN_SEQUENCE[Number(match.turn_index)] : 0,
    is_your_turn: match.status === 'active' && arenaCurrentPlayerId(match) === Number(userId)
  };
}

export function getArenaStateForUser(userId, now = new Date()) {
  ensureArenaState();
  const queued = state.cards.arena.entries.find(entry =>
    Number(entry.user_id) === Number(userId) && entry.status === 'queued'
  ) || null;
  const matches = state.cards.arena.matches
    .filter(match => match.player_ids.map(Number).includes(Number(userId)))
    .sort((a, b) => Number(b.id) - Number(a.id));
  const resolvedMatches = matches.filter(match =>
    match.status === 'completed' ||
    (match.status === 'ready' && (match.revealed_by || []).map(Number).includes(Number(userId)))
  );
  const wins = resolvedMatches.filter(match => Number(match.winner_user_id) === Number(userId)).length;
  const losses = resolvedMatches.filter(match =>
    match.winner_user_id != null && Number(match.winner_user_id) !== Number(userId)
  ).length;
  return {
    config: JSON.parse(JSON.stringify(state.cards.arena.config)),
    nextMatchmakingAt: nextArenaMatchmakingAt(now).toISOString(),
    queueCount: state.cards.arena.entries.filter(entry => entry.status === 'queued').length,
    queuedEntry: queued ? { ...queued } : null,
    record: { wins, losses },
    activeMatches: matches.filter(match => match.status === 'active').map(match => publicArenaMatch(match, userId)),
    readyMatches: matches.filter(match => match.status === 'ready' && !(match.revealed_by || []).map(Number).includes(Number(userId))).map(match => publicArenaMatch(match, userId)),
    history: matches.filter(match => match.status === 'completed' || (match.status === 'ready' && (match.revealed_by || []).map(Number).includes(Number(userId)))).map(match => publicArenaMatch(match, userId)),
    serverNow: now.toISOString()
  };
}

export function enterArenaQueue(userId, now = new Date()) {
  ensureArenaState();
  const arena = state.cards.arena;
  if (activeArenaMatchesForUser(userId).length >= Number(arena.config.maxActiveMatches || 3)) {
    throw new Error(`You already have ${arena.config.maxActiveMatches} active WUT matches.`);
  }
  if (arena.entries.some(entry =>
    Number(entry.user_id) === Number(userId) && entry.status === 'queued'
  )) throw new Error('You are already in the WUT queue.');
  const user = state.users.find(item => Number(item.id) === Number(userId));
  if (!user) throw new Error('User not found.');
  const entry = {
    id: arena.nextEntryId++, user_id: Number(userId), entered_date: arenaLocalDateKey(now),
    paid_amount: ARENA_ENTRY_FEE, priority: false, status: 'queued', created_at: now.toISOString()
  };
  arena.entries.push(entry);
  saveState();
  return { ...entry };
}

function shuffleArenaEntries(entries) {
  const copy = [...entries];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

export function assignArenaMatchups(now = new Date()) {
  ensureArenaState();
  const arena = state.cards.arena;
  const eligible = arena.entries.filter(entry => entry.status === 'queued' &&
    activeArenaMatchesForUser(entry.user_id).length < Number(arena.config.maxActiveMatches || 3));
  const priority = shuffleArenaEntries(eligible.filter(entry => entry.priority));
  const normal = shuffleArenaEntries(eligible.filter(entry => !entry.priority));
  const ordered = [...priority, ...normal];
  const created = [];
  while (ordered.length >= 2) {
    const firstEntry = ordered.shift();
    const secondEntry = ordered.shift();
    firstEntry.status = 'matched'; secondEntry.status = 'matched';
    firstEntry.matched_at = now.toISOString(); secondEntry.matched_at = now.toISOString();
    const firstPlayerId = Math.random() < 0.5 ? firstEntry.user_id : secondEntry.user_id;
    const match = {
      id: arena.nextMatchId++, player_ids: [Number(firstEntry.user_id), Number(secondEntry.user_id)],
      entry_ids: [firstEntry.id, secondEntry.id], first_player_id: Number(firstPlayerId),
      turn_index: 0, turn_deadline: new Date(now.getTime() + Number(arena.config.turnHours || 24) * 3600000).toISOString(),
      entry_fee: ARENA_ENTRY_FEE, prize_amount: ARENA_WINNER_PRIZE,
      placements: [], status: 'active', scores: null, winner_user_id: null, winnings_claimed_at: null,
      created_at: now.toISOString(), resolved_at: null, completed_at: null
    };
    arena.matches.push(match); created.push(match.id);
  }
  if (ordered.length === 1) {
    const unmatched = ordered[0];
    unmatched.priority = true;
    unmatched.carried_at = now.toISOString();
  }
  arena.lastMatchmakingHour = arenaHourKey(now);
  saveState();
  return {
    createdMatchIds: created,
    unmatchedUserId: ordered[0]?.user_id || null,
    lastMatchmakingHour: arena.lastMatchmakingHour
  };
}

export function getArenaAdminState(now = new Date()) {
  ensureArenaState();
  const currentHour = arenaHourKey(now);
  return {
    lastMatchmakingHour: state.cards.arena.lastMatchmakingHour,
    matchmakingDue: state.cards.arena.lastMatchmakingHour !== currentHour,
    nextMatchmakingAt: nextArenaMatchmakingAt(now).toISOString(),
    queued: state.cards.arena.entries.filter(entry => entry.status === 'queued').length,
    active: state.cards.arena.matches.filter(match => match.status === 'active').length,
    ready: state.cards.arena.matches.filter(match => match.status === 'ready').length,
    config: JSON.parse(JSON.stringify(state.cards.arena.config))
  };
}

function catalogPlayerForOwnedCard(card, catalogByIdentity) {
  return catalogByIdentity?.[card.card_identity] ||
    catalogByIdentity?.[`${card.edition || 'S3'}|${card.division_id}|${card.player_key}`] ||
    catalogByIdentity?.[`${card.division_id}|${card.player_key}`] || null;
}

function arenaLockedCardIds(userId, exceptMatchId = null) {
  return new Set(state.cards.arena.matches.flatMap(match => {
    if (!['active', 'scoring'].includes(match.status) || Number(match.id) === Number(exceptMatchId)) return [];
    return match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id));
  }));
}

export function commitArenaTurn({ userId, matchId, placements, catalogByIdentity, now = new Date(), automatic = false }) {
  ensureArenaState();
  const match = state.cards.arena.matches.find(item => Number(item.id) === Number(matchId));
  if (!match || !match.player_ids.map(Number).includes(Number(userId))) throw new Error('WUT match not found.');
  if (match.status !== 'active') throw new Error('This WUT match is already resolved.');
  if (arenaCurrentPlayerId(match) !== Number(userId)) throw new Error('It is not your turn.');
  const required = ARENA_TURN_SEQUENCE[Number(match.turn_index)];
  if (!Array.isArray(placements) || placements.length !== required) {
    throw new Error(`This turn requires exactly ${required} card${required === 1 ? '' : 's'}.`);
  }
  const existingSlots = new Set(match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => row.slot));
  const existingCardIds = new Set(match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id)));
  const lockedElsewhere = arenaLockedCardIds(userId, match.id);
  const turnSlots = new Set(); const turnCards = new Set(); const turnBoosts = new Set();
  const cleaned = placements.map(input => {
    const slot = String(input.slot || '').toUpperCase();
    if (!CARD_LINEUP_SLOTS.includes(slot) || existingSlots.has(slot) || turnSlots.has(slot)) throw new Error('Choose each open lineup slot only once.');
    turnSlots.add(slot);
    const card = state.cards.ownedCards.find(item => Number(item.id) === Number(input.cardId) && Number(item.user_id) === Number(userId));
    if (!card) throw new Error('Card not found in your collection.');
    if (Number(card.cooldown_remaining || 0) > 0) throw new Error('That card is on cooldown.');
    if (existingCardIds.has(Number(card.id)) || turnCards.has(Number(card.id)) || lockedElsewhere.has(Number(card.id))) throw new Error('That card is already committed to an active WUT match.');
    turnCards.add(Number(card.id));
    const player = catalogPlayerForOwnedCard(card, catalogByIdentity);
    const requiredPosition = slot === 'G' ? 'G' : slot[0];
    if (!player || player.position !== requiredPosition) throw new Error(`That card is not eligible for ${slot}.`);
    const duplicatePlayer = match.placements.some(row => {
      if (Number(row.user_id) !== Number(userId)) return false;
      const other = state.cards.ownedCards.find(item => Number(item.id) === Number(row.card_id));
      return other && (other.source_player_key || other.player_key) === (card.source_player_key || card.player_key) && other.division_id === card.division_id;
    }) || [...turnCards].some(cardId => {
      if (Number(cardId) === Number(card.id)) return false;
      const other = state.cards.ownedCards.find(item => Number(item.id) === Number(cardId));
      return other && (other.source_player_key || other.player_key) === (card.source_player_key || card.player_key) && other.division_id === card.division_id;
    });
    if (duplicatePlayer) throw new Error('The same player cannot appear twice in one lineup.');
    let boost = null;
    if (input.boostId) {
      boost = state.cards.ownedBoosts.find(item => Number(item.id) === Number(input.boostId) && Number(item.user_id) === Number(userId) && !item.consumed);
      if (!boost || turnBoosts.has(Number(boost.id)) || state.cards.arena.matches.some(other => ['active', 'scoring'].includes(other.status) && other.placements.some(row => Number(row.boost_id) === Number(boost.id)))) {
        throw new Error('That boost is unavailable.');
      }
      const goalieBoost = ['save', 'shutout'].includes(boost.boost_type);
      if ((player.position === 'G') !== goalieBoost) throw new Error('That boost does not fit this position.');
      turnBoosts.add(Number(boost.id));
    }
    return { user_id: Number(userId), slot, card_id: Number(card.id), boost_id: boost?.id || null, automatic: Boolean(automatic), committed_at: now.toISOString() };
  });
  match.placements.push(...cleaned);
  match.turn_index += 1;
  if (match.turn_index >= ARENA_TURN_SEQUENCE.length) {
    match.status = 'scoring';
    match.turn_deadline = null;
  } else {
    match.turn_deadline = new Date(now.getTime() + Number(state.cards.arena.config.turnHours || 24) * 3600000).toISOString();
  }
  saveState();
  return publicArenaMatch(match, userId);
}

export function autoAssignExpiredArenaTurns(catalogByIdentity, now = new Date()) {
  ensureArenaState();
  const changed = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const match of state.cards.arena.matches.filter(item => item.status === 'active' && new Date(item.turn_deadline) <= now)) {
      const userId = arenaCurrentPlayerId(match);
      const count = ARENA_TURN_SEQUENCE[match.turn_index];
      const occupied = new Set(match.placements.filter(row => Number(row.user_id) === userId).map(row => row.slot));
      const locked = arenaLockedCardIds(userId, match.id);
      const already = new Set(match.placements.filter(row => Number(row.user_id) === userId).map(row => Number(row.card_id)));
      const candidates = state.cards.ownedCards.filter(card => Number(card.user_id) === userId && !locked.has(Number(card.id)) && !already.has(Number(card.id)) && Number(card.cooldown_remaining || 0) <= 0)
        .map(card => ({ card, player: catalogPlayerForOwnedCard(card, catalogByIdentity) }))
        .filter(row => row.player?.position)
        .sort((a, b) => (ARENA_RARITY_RANK[a.player.tier] || 99) - (ARENA_RARITY_RANK[b.player.tier] || 99) || Number(a.card.id) - Number(b.card.id));
      const picked = [];
      for (const slot of CARD_LINEUP_SLOTS.filter(slot => !occupied.has(slot))) {
        const position = slot === 'G' ? 'G' : slot[0];
        const index = candidates.findIndex(row => row.player.position === position && !picked.some(item => item.player.playerKey === row.player.playerKey && item.player.divisionId === row.player.divisionId));
        if (index < 0) continue;
        const [choice] = candidates.splice(index, 1);
        picked.push({ ...choice, slot });
        if (picked.length === count) break;
      }
      if (picked.length !== count) continue;
      commitArenaTurn({ userId, matchId: match.id, placements: picked.map(row => ({ slot: row.slot, cardId: row.card.id })), catalogByIdentity, now, automatic: true });
      changed.push(match.id); progressed = true;
    }
  }
  return [...new Set(changed)];
}

export function getArenaMatchesNeedingScoring() {
  ensureCardsState();
  return state.cards.arena.matches.filter(match => match.status === 'scoring').map(match => JSON.parse(JSON.stringify(match)));
}

export function completeArenaMatch(matchId, scoredPlacements, now = new Date()) {
  ensureCardsState();
  const match = state.cards.arena.matches.find(item => Number(item.id) === Number(matchId));
  if (!match || match.status !== 'scoring') return match ? JSON.parse(JSON.stringify(match)) : null;
  match.placements = scoredPlacements.map(row => JSON.parse(JSON.stringify(row)));
  const totals = Object.fromEntries(match.player_ids.map(userId => [String(userId), match.placements.filter(row => Number(row.user_id) === Number(userId)).reduce((sum, row) => sum + Number(row.fp || 0), 0)]));
  match.scores = totals;
  const [a, b] = match.player_ids;
  match.winner_user_id = totals[String(a)] === totals[String(b)] ? null : (totals[String(a)] > totals[String(b)] ? Number(a) : Number(b));
  match.status = 'ready'; match.resolved_at = now.toISOString();
  for (const userId of match.player_ids) {
    for (const card of state.cards.ownedCards.filter(item => Number(item.user_id) === Number(userId))) card.cooldown_remaining = Math.max(0, Number(card.cooldown_remaining || 0) - 1);
    for (const row of match.placements.filter(item => Number(item.user_id) === Number(userId))) {
      const card = state.cards.ownedCards.find(item => Number(item.id) === Number(row.card_id));
      if (card) {
        const rarity = row.card_rarity || 'common';
        card.cooldown_remaining = Number(ARENA_COOLDOWNS[rarity] || 0);
        card.total_fp_for_user = Number(card.total_fp_for_user || 0) + Number(row.fp || 0);
        card.best_week_fp = Math.max(Number(card.best_week_fp || 0), Number(row.fp || 0));
        card.last_week_fp = Number(row.fp || 0);
        card.fantasy_stats[`arena-${match.id}`] = { fp: row.fp, gamesPlayed: row.games_played, stats: row.stats, sampleMatchIds: row.sample_match_ids, syntheticGames: row.synthetic_games, scoreBreakdown: row.score_breakdown, boostId: row.boost_id || null };
      }
      if (row.boost_id) {
        const boost = state.cards.ownedBoosts.find(item => Number(item.id) === Number(row.boost_id));
        if (boost) { boost.consumed = true; boost.used_match_id = match.id; boost.used_slot = row.slot; }
      }
    }
  }
  saveState();
  return JSON.parse(JSON.stringify(match));
}

export function completeArenaReveal(userId, matchId, now = new Date()) {
  ensureCardsState();
  const match = state.cards.arena.matches.find(item => Number(item.id) === Number(matchId) && item.player_ids.map(Number).includes(Number(userId)));
  if (!match || !['ready', 'completed'].includes(match.status)) throw new Error('WUT result is not ready.');
  match.revealed_by = Array.isArray(match.revealed_by) ? match.revealed_by : [];
  if (!match.revealed_by.map(Number).includes(Number(userId))) match.revealed_by.push(Number(userId));
  if (match.revealed_by.length >= match.player_ids.length) {
    match.status = 'completed';
    match.completed_at = match.completed_at || now.toISOString();
  }
  saveState();
  return publicArenaMatch(match, userId);
}

export function claimArenaWinnings(userId, matchId, now = new Date()) {
  ensureCardsState();
  const match = state.cards.arena.matches.find(item => Number(item.id) === Number(matchId));
  if (!match || !match.player_ids.map(Number).includes(Number(userId))) throw new Error('WUT match not found.');
  if (Number(match.winner_user_id) !== Number(userId)) throw new Error('Only the winner can collect these winnings.');
  if (!(match.revealed_by || []).map(Number).includes(Number(userId))) throw new Error('Reveal the match result before collecting winnings.');
  if (match.winnings_claimed_at) throw new Error('These winnings were already collected.');
  const user = state.users.find(item => Number(item.id) === Number(userId));
  const prize = Math.ceil(Number(match.prize_amount ?? ARENA_WINNER_PRIZE));
  user.balance = Number(user.balance || 0) + prize;
  match.winnings_claimed_at = now.toISOString(); match.winnings_claimed_by = Number(userId);
  state.transactions.push({ id: state.nextTransactionId++, user_id: Number(userId), week: Number(state.settings.currentWeek || 1), amount: prize, kind: 'arena_winnings', category: 'cards', note: `WUT match #${match.id} winnings`, arena_match_id: match.id, created_at: now.toISOString() });
  saveState();
  return { prize, balance: user.balance };
}

export function getCardsLineup(userId, week) {
  ensureCardsState();
  const rows = state.cards.lineups.filter(row =>
    Number(row.user_id) === Number(userId) && Number(row.week) === Number(week)
  );
  return CARD_LINEUP_SLOTS.map(slot => {
    const row = rows.find(item => item.slot === slot);
    return row ? { ...row } : {
      user_id: Number(userId),
      week: Number(week),
      slot,
      card_id: null,
      boost_id: null,
      selected_series_key: '',
      sample_match_ids: [],
      synthetic_games: [],
      score_breakdown: [],
      locked: false,
      finalized: false,
      fp: null,
      resources_resolved: false,
      resources_resolved_at: null
    };
  });
}

export function getAllCardsLineupsForWeek(week) {
  ensureCardsState();
  return state.cards.lineups
    .filter(row => Number(row.week) === Number(week))
    .map(row => ({ ...row }));
}

export function setCardsLineupSlot({
  userId,
  week,
  slot,
  cardId = null,
  boostId = null,
  selectedSeriesKey = ''
}) {
  ensureCardsState();
  const cleanSlot = String(slot || '').toUpperCase();
  if (!CARD_LINEUP_SLOTS.includes(cleanSlot)) throw new Error('Invalid lineup slot.');
  const existing = state.cards.lineups.find(row =>
    Number(row.user_id) === Number(userId) &&
    Number(row.week) === Number(week) &&
    row.slot === cleanSlot
  );
  if (existing?.locked) throw new Error('This lineup slot is locked.');

  const card = cardId == null || cardId === ''
    ? null
    : state.cards.ownedCards.find(item =>
      Number(item.id) === Number(cardId) &&
      Number(item.user_id) === Number(userId)
    );
  if (cardId && !card) throw new Error('Card not found in your collection.');
  if (card && Number(card.cooldown_remaining || 0) > 0) throw new Error('That card is on cooldown.');

  if (card) {
    const duplicate = state.cards.lineups.find(row => {
      if (
        Number(row.user_id) !== Number(userId) ||
        Number(row.week) !== Number(week) ||
        row.slot === cleanSlot ||
        !row.card_id
      ) return false;
      const other = state.cards.ownedCards.find(item => Number(item.id) === Number(row.card_id));
      return other &&
        (other.source_player_key || other.player_key) === (card.source_player_key || card.player_key) &&
        other.division_id === card.division_id;
    });
    if (duplicate) throw new Error('The same player cannot appear twice in one lineup.');
  }

  const boost = boostId == null || boostId === ''
    ? null
    : state.cards.ownedBoosts.find(item =>
      Number(item.id) === Number(boostId) &&
      Number(item.user_id) === Number(userId) &&
      !item.consumed
    );
  if (boostId && !boost) throw new Error('Boost not found or already consumed.');
  if (boost) {
    const usedElsewhere = state.cards.lineups.some(row =>
      Number(row.user_id) === Number(userId) &&
      Number(row.week) === Number(week) &&
      row.slot !== cleanSlot &&
      Number(row.boost_id) === Number(boost.id)
    );
    if (usedElsewhere) throw new Error('That boost is already assigned to another slot.');
  }

  const next = {
    user_id: Number(userId),
    week: Number(week),
    slot: cleanSlot,
    card_id: card ? Number(card.id) : null,
    boost_id: boost ? Number(boost.id) : null,
    selected_series_key: card ? String(selectedSeriesKey || '') : '',
    sample_match_ids: existing?.sample_match_ids || [],
    synthetic_games: existing?.synthetic_games || [],
    score_breakdown: existing?.score_breakdown || [],
    locked: false,
    finalized: false,
    fp: null,
    resources_resolved: false,
    resources_resolved_at: null,
    stats: null,
    warning: '',
    updated_at: nowIso()
  };
  if (existing) Object.assign(existing, next);
  else state.cards.lineups.push(next);
  saveState();
  return { ...next };
}

export function resolveCardsLineupResult({
  userId,
  week,
  slot,
  seriesComplete,
  gamesPlayed,
  fp,
  stats,
  sampleMatchIds = [],
  syntheticGames = [],
  scoreBreakdown = [],
  warning = '',
  allowResolvedUpdate = false
}) {
  ensureCardsState();
  const lineup = state.cards.lineups.find(row =>
    Number(row.user_id) === Number(userId) &&
    Number(row.week) === Number(week) &&
    row.slot === String(slot)
  );
  if (!lineup || !lineup.card_id) return null;
  if (lineup.resources_resolved && !allowResolvedUpdate) return { ...lineup };
  lineup.warning = String(warning || '');
  const appeared = Number(gamesPlayed || 0) > 0;
  if (!appeared) {
    lineup.locked = false;
    lineup.finalized = false;
    lineup.fp = null;
    lineup.stats = null;
    saveState();
    return { ...lineup };
  }

  lineup.locked = true;
  lineup.finalized = true;
  lineup.fp = Number(fp || 0);
  lineup.stats = stats || {};
  lineup.sample_match_ids = Array.isArray(sampleMatchIds) ? sampleMatchIds.map(String) : [];
  lineup.synthetic_games = Array.isArray(syntheticGames) ? JSON.parse(JSON.stringify(syntheticGames)) : [];
  lineup.score_breakdown = Array.isArray(scoreBreakdown) ? JSON.parse(JSON.stringify(scoreBreakdown)) : [];

  if (lineup.resources_resolved && allowResolvedUpdate) {
    const card = state.cards.ownedCards.find(item => Number(item.id) === Number(lineup.card_id));
    const boost = lineup.boost_id
      ? state.cards.ownedBoosts.find(item => Number(item.id) === Number(lineup.boost_id))
      : null;
    if (card) {
      const weekKey = String(week);
      const previousFp = Number(card.fantasy_stats?.[weekKey]?.fp || 0);
      const nextFp = Number(fp || 0);
      card.total_fp_for_user = Number(card.total_fp_for_user || 0) + nextFp - previousFp;
      card.last_week_fp = nextFp;
      card.fantasy_stats[weekKey] = {
        ...(card.fantasy_stats[weekKey] || {}),
        fp: nextFp,
        gamesPlayed: Number(gamesPlayed || 0),
        stats: stats || {},
        seriesKey: lineup.selected_series_key,
        sampleMatchIds: lineup.sample_match_ids,
        syntheticGames: lineup.synthetic_games,
        scoreBreakdown: lineup.score_breakdown,
        boostId: boost?.id || null
      };
      card.best_week_fp = Math.max(
        0,
        ...Object.values(card.fantasy_stats || {}).map(entry => Number(entry?.fp || 0))
      );
    }
    saveState();
    return { ...lineup };
  }

  if (!lineup.resources_resolved) {
    const card = state.cards.ownedCards.find(item => Number(item.id) === Number(lineup.card_id));
    const boost = lineup.boost_id
      ? state.cards.ownedBoosts.find(item => Number(item.id) === Number(lineup.boost_id))
      : null;
    if (card) {
      card.weeks_started = Number(card.weeks_started || 0) + 1;
      card.total_fp_for_user = Number(card.total_fp_for_user || 0) + Number(fp || 0);
      card.best_week_fp = Math.max(Number(card.best_week_fp || 0), Number(fp || 0));
      card.last_week_fp = Number(fp || 0);
      card.fantasy_stats[String(week)] = {
        fp: Number(fp || 0),
        gamesPlayed: Number(gamesPlayed || 0),
        stats: stats || {},
        seriesKey: lineup.selected_series_key,
        sampleMatchIds: lineup.sample_match_ids,
        syntheticGames: lineup.synthetic_games,
        scoreBreakdown: lineup.score_breakdown,
        boostId: boost?.id || null
      };
    }
    if (boost) {
      boost.consumed = true;
      boost.used_week = Number(week);
      boost.used_slot = lineup.slot;
    }
    lineup.resources_resolved = true;
    lineup.resources_resolved_at = nowIso();
  }
  saveState();
  return { ...lineup };
}

export function createCardsPackPurchase({
  userId,
  week,
  packKind,
  packType,
  price,
  items
}) {
  ensureCardsState();
  const user = state.users.find(item => Number(item.id) === Number(userId));
  if (!user) throw new Error('User not found.');
  const pending = state.cards.packPurchases.find(item =>
    Number(item.user_id) === Number(userId) && item.status === 'pending'
  );
  if (pending) throw new Error('Add your current pack to the collection before buying another.');
  const cleanPrice = Math.ceil(Number(price || 0));
  if (cleanPrice <= 0) throw new Error('Invalid pack price.');
  if (Number(user.balance || 0) < cleanPrice) throw new Error('Insufficient balance.');
  if (!Array.isArray(items) || items.length !== 3) throw new Error('A pack must contain exactly three items.');

  user.balance = Number(user.balance || 0) - cleanPrice;
  const purchase = {
    id: state.nextPackPurchaseId++,
    user_id: Number(userId),
    week: Number(week),
    pack_kind: String(packKind),
    pack_type: String(packType),
    price: cleanPrice,
    items: JSON.parse(JSON.stringify(items)),
    status: 'pending',
    created_at: nowIso(),
    claimed_at: null
  };
  state.cards.packPurchases.push(purchase);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    week: Number(week),
    amount: -cleanPrice,
    kind: 'cards_pack_purchase',
    category: 'cards',
    note: `${packType} ${packKind} pack`,
    cards_pack_purchase_id: purchase.id,
    created_at: nowIso()
  });
  saveState();
  return JSON.parse(JSON.stringify(purchase));
}

export function getPendingCardsPack(userId) {
  ensureCardsState();
  const purchase = state.cards.packPurchases.find(item =>
    Number(item.user_id) === Number(userId) && item.status === 'pending'
  );
  return purchase ? JSON.parse(JSON.stringify(purchase)) : null;
}

function createOwnedPlayerCard(userId, item, acquiredWeek) {
  const card = {
    id: state.nextOwnedCardId++,
    user_id: Number(userId),
    division_id: item.divisionId,
    player_key: item.playerKey,
    card_identity: item.cardIdentity || item.catalogKey || `${item.edition || 'S3'}|${item.divisionId}|${item.playerKey}`,
    card_type: item.cardType || item.card_type || 'player',
    edition: item.edition || 'S3',
    source_season: item.sourceSeason || item.source_season || item.edition || 'S3',
    source_stage: item.sourceStage || item.source_stage || 'reg',
    source_team_id: item.sourceTeamId || item.source_team_id || '',
    source_player_key: item.sourcePlayerKey || item.source_player_key || item.playerKey,
    source_steam_id: item.sourceSteamId || item.source_steam_id || '',
    display_name: item.displayName || item.display_name || '',
    acquired_week: Number(acquiredWeek),
    cooldown_remaining: 0,
    retired: false,
    weeks_started: 0,
    total_fp_for_user: 0,
    best_week_fp: 0,
    last_week_fp: 0,
    fantasy_stats: {},
    created_at: nowIso()
  };
  state.cards.ownedCards.push(card);
  return card;
}

export function claimCardsPack(userId, purchaseId) {
  ensureCardsState();
  const purchase = state.cards.packPurchases.find(item =>
    Number(item.id) === Number(purchaseId) &&
    Number(item.user_id) === Number(userId)
  );
  if (!purchase) throw new Error('Pack not found.');
  if (purchase.status !== 'pending') throw new Error('This pack was already added to the collection.');

  const created = [];
  for (const item of purchase.items) {
    if (item.itemType === 'player') {
      const card = createOwnedPlayerCard(userId, item, purchase.week);
      created.push({ ...card, itemType: 'player' });
    } else {
      const boost = {
        id: state.nextOwnedBoostId++,
        user_id: Number(userId),
        boost_type: item.boostType,
        rarity: item.rarity,
        effect: item.effect ? JSON.parse(JSON.stringify(item.effect)) : null,
        used_week: null,
        used_slot: '',
        consumed: false,
        created_at: nowIso()
      };
      state.cards.ownedBoosts.push(boost);
      created.push({ ...boost, itemType: 'boost' });
    }
  }
  purchase.status = 'claimed';
  purchase.claimed_at = nowIso();
  saveState();
  return created;
}

export function openWutStarterPack({ userId, items }) {
  ensureCardsState();
  const membership = state.cards.wutMemberships.find(entry => Number(entry.user_id) === Number(userId));
  if (!membership) throw new Error('Join WUT before opening your starter pack.');
  if (membership.starter_opened_at) throw new Error('Your WUT starter pack has already been opened.');
  if (!Array.isArray(items) || items.length !== 5) throw new Error('A WUT starter pack must contain exactly five cards.');
  if (items.some(item => item.itemType !== 'player' || item.rolledTier !== 'common')) {
    throw new Error('A WUT starter pack can only contain common player cards.');
  }
  const positions = items.map(item => String(item.position || '').toUpperCase()).sort().join('');
  if (positions !== 'DDFFG') throw new Error('A WUT starter pack must contain two forwards, two defense, and one goalie.');
  if (new Set(items.map(item => item.cardIdentity || item.catalogKey)).size !== 5) {
    throw new Error('A WUT starter pack cannot contain duplicate cards.');
  }

  const created = items.map(item => createOwnedPlayerCard(userId, item, state.settings.currentWeek));
  membership.starter_card_ids = created.map(card => card.id);
  membership.starter_opened_at = nowIso();
  saveState();
  return created.map(card => ({ ...card, itemType: 'player' }));
}

export function grantCardsTestItem({ userId, item }) {
  ensureCardsState();
  const fakePurchase = {
    id: state.nextPackPurchaseId++,
    user_id: Number(userId),
    week: Number(state.settings.currentWeek),
    pack_kind: item.itemType === 'player' ? 'player' : 'boost',
    pack_type: 'admin_grant',
    price: 0,
    items: [item],
    status: 'pending',
    created_at: nowIso(),
    claimed_at: null
  };
  state.cards.packPurchases.push(fakePurchase);
  const originalItems = fakePurchase.items;
  if (originalItems.length === 1) {
    fakePurchase.items = [item, item, item];
    const created = claimCardsPack(userId, fakePurchase.id);
    const keep = created[0];
    if (item.itemType === 'player') {
      const removeIds = new Set(created.slice(1).map(entry => entry.id));
      state.cards.ownedCards = state.cards.ownedCards.filter(entry => !removeIds.has(entry.id));
    } else {
      const removeIds = new Set(created.slice(1).map(entry => entry.id));
      state.cards.ownedBoosts = state.cards.ownedBoosts.filter(entry => !removeIds.has(entry.id));
    }
    fakePurchase.items = originalItems;
    saveState();
    return keep;
  }
  return null;
}

export function getCardsWeekReviews(userId) {
  ensureCardsState();
  return state.cards.weekReviews
    .filter(review => Number(review.user_id) === Number(userId))
    .sort((a, b) => Number(b.week) - Number(a.week))
    .map(review => JSON.parse(JSON.stringify(review)));
}

export function acknowledgeCardsWeekReview(userId, week) {
  ensureCardsState();
  const review = state.cards.weekReviews.find(item =>
    Number(item.user_id) === Number(userId) && Number(item.week) === Number(week)
  );
  if (!review) throw new Error('Cards week review not found.');
  review.acknowledged = true;
  review.acknowledged_at = nowIso();
  saveState();
  return JSON.parse(JSON.stringify(review));
}

export function finalizeCardsWeek({ week, nextWeek, results, calculatedTiers = {} }) {
  ensureCardsState();
  const targetWeek = Number(week);
  const targetNextWeek = Number(nextWeek);
  state.cards.calculatedTiers = { ...calculatedTiers };
  const byUser = new Map();

  for (const result of results || []) {
    const lineup = state.cards.lineups.find(row =>
      Number(row.user_id) === Number(result.userId) &&
      Number(row.week) === targetWeek &&
      row.slot === result.slot
    );
    if (!lineup || !lineup.card_id) continue;
    const card = state.cards.ownedCards.find(item => Number(item.id) === Number(lineup.card_id));
    const boost = lineup.boost_id
      ? state.cards.ownedBoosts.find(item => Number(item.id) === Number(lineup.boost_id))
      : null;
    const appeared = Number(result.gamesPlayed || 0) > 0;
    lineup.finalized = appeared;
    lineup.locked = appeared;
    lineup.fp = appeared ? Number(result.fp || 0) : null;
    lineup.stats = appeared ? (result.stats || null) : null;
    lineup.sample_match_ids = appeared && Array.isArray(result.sampleMatchIds) ? result.sampleMatchIds.map(String) : [];
    lineup.synthetic_games = appeared && Array.isArray(result.syntheticGames) ? JSON.parse(JSON.stringify(result.syntheticGames)) : [];
    lineup.score_breakdown = appeared && Array.isArray(result.scoreBreakdown) ? JSON.parse(JSON.stringify(result.scoreBreakdown)) : [];
    lineup.warning = result.warning || '';

    if (!byUser.has(Number(result.userId))) byUser.set(Number(result.userId), []);
    byUser.get(Number(result.userId)).push({
      slot: lineup.slot,
      cardId: lineup.card_id,
      boostId: lineup.boost_id,
      selectedSeriesKey: lineup.selected_series_key,
      finalized: lineup.finalized,
      gamesPlayed: Number(result.gamesPlayed || 0),
      fp: lineup.fp,
      stats: result.stats || {},
      sampleMatchIds: lineup.sample_match_ids,
      syntheticGames: lineup.synthetic_games,
      scoreBreakdown: lineup.score_breakdown,
      warning: lineup.warning
    });

    if (card && !card.retired) {
      const existingNext = state.cards.lineups.find(row =>
        Number(row.user_id) === Number(result.userId) &&
        Number(row.week) === targetNextWeek &&
        row.slot === lineup.slot
      );
      const nextRow = {
        user_id: Number(result.userId),
        week: targetNextWeek,
        slot: lineup.slot,
        card_id: card.id,
        boost_id: boost && !boost.consumed ? boost.id : null,
        selected_series_key: '',
        sample_match_ids: [],
        synthetic_games: [],
        score_breakdown: [],
        locked: false,
        finalized: false,
        fp: null,
        resources_resolved: false,
        resources_resolved_at: null,
        stats: null,
        warning: '',
        updated_at: nowIso()
      };
      if (existingNext) Object.assign(existingNext, nextRow);
      else state.cards.lineups.push(nextRow);
    }
  }

  for (const user of state.users) {
    const entries = byUser.get(Number(user.id)) || [];
    const existing = state.cards.weekReviews.find(review =>
      Number(review.user_id) === Number(user.id) && Number(review.week) === targetWeek
    );
    const review = {
      user_id: Number(user.id),
      week: targetWeek,
      total_fp: entries.reduce((sum, entry) => sum + Number(entry.fp || 0), 0),
      lineup: entries,
      acknowledged: false,
      created_at: existing?.created_at || nowIso()
    };
    if (existing) Object.assign(existing, review);
    else state.cards.weekReviews.push(review);
  }
  saveState();
  return { users: state.users.length, results: (results || []).length };
}

export function getCardsLeaderboard(week = null) {
  ensureCardsState();
  const targetWeek = week == null ? null : Number(week);
  return state.users.map(user => {
    const reviews = state.cards.weekReviews.filter(review =>
      Number(review.user_id) === Number(user.id) &&
      (targetWeek == null || Number(review.week) === targetWeek)
    );
    return {
      user_id: user.id,
      display_name: user.display_name,
      fp: reviews.reduce((sum, review) => sum + Number(review.total_fp || 0), 0)
    };
  }).sort((a, b) => b.fp - a.fp || a.display_name.localeCompare(b.display_name));
}

export function resetCardsData() {
  ensureCardsState();
  const transactions = state.transactions.filter(transaction => transaction.category === 'cards');
  const netByUser = new Map();
  for (const transaction of transactions) {
    const uid = Number(transaction.user_id);
    netByUser.set(uid, (netByUser.get(uid) || 0) + Number(transaction.amount || 0));
  }
  for (const [uid, net] of netByUser.entries()) {
    const user = state.users.find(item => Number(item.id) === uid);
    if (user) user.balance = Number(user.balance || 0) - net;
  }
  const config = state.cards.config;
  const positionOverrides = state.cards.positionOverrides;
  const tierOverrides = state.cards.tierOverrides;
  state.cards = {
    ...defaultState().cards,
    config,
    positionOverrides,
    tierOverrides
  };
  state.transactions = state.transactions.filter(transaction => transaction.category !== 'cards');
  state.nextOwnedCardId = 1;
  state.nextOwnedBoostId = 1;
  state.nextPackPurchaseId = 1;
  saveState();
  return { usersRestored: netByUser.size, transactionsRemoved: transactions.length };
}


function horseRaceStore() {
  ensureCasinoState();
  return state.casino.horseRacing;
}

export function getHorseRacingConfig() {
  return JSON.parse(JSON.stringify(horseRaceStore().config));
}

export function saveHorseRacingConfig({ maxBet, horsePurchasePrice, ownerBetSharePercent, ownerWinBonus }) {
  const store = horseRaceStore();
  const cleanWhole = (value, label, allowZero = false) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
      throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} whole number.`);
    }
    return parsed;
  };
  const share = Number(ownerBetSharePercent);
  if (!Number.isFinite(share) || share < 0 || share > 100) {
    throw new Error('Horse owner bet cut must be between 0% and 100%.');
  }
  store.config = {
    maxBet: cleanWhole(maxBet, 'Horse racing max bet'),
    horsePurchasePrice: cleanWhole(horsePurchasePrice, 'Horse purchase price'),
    ownerBetSharePercent: Number(share.toFixed(2)),
    ownerWinBonus: cleanWhole(ownerWinBonus, 'Horse win bonus', true)
  };
  saveState();
  return getHorseRacingConfig();
}

function createHorseRace(dateKey, raceNumber, now) {
  const store = horseRaceStore();
  const schedule = getHorseRaceSchedule(dateKey, raceNumber);
  const selectedHorseIds = shuffledHorseIds(store.horses).slice(0, HORSE_RACING_CONFIG.raceHorseCount);
  if (selectedHorseIds.length < HORSE_RACING_CONFIG.raceHorseCount) {
    throw new Error(`At least ${HORSE_RACING_CONFIG.raceHorseCount} horses are required to create a race.`);
  }
  const horsesById = new Map(store.horses.map(horse => [String(horse.id), horse]));
  const race = {
    id: store.nextRaceId++,
    race_date: dateKey,
    race_number: Number(raceNumber),
    schedule_version: 2,
    time_zone: HORSE_RACING_CONFIG.timeZone,
    betting_opens_at: schedule.bettingOpensAt?.toISOString() || null,
    betting_closes_at: schedule.bettingClosesAt.toISOString(),
    race_starts_at: schedule.raceStartsAt.toISOString(),
    horse_names: selectedHorseIds.map(horseId => {
      const horse = horsesById.get(String(horseId));
      return { id: horse.id, name: horse.name };
    }),
    horse_image: HORSE_RACING_CONFIG.horseImage,
    status: 'upcoming',
    finishing_order: null,
    pace_seed: null,
    race_duration_seconds: null,
    result_generated_at: null,
    settled_at: null,
    debug_state: null,
    debug_race_starts_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  store.races.push(race);
  return race;
}

function scheduleForStoredHorseRace(race) {
  return {
    bettingOpensAt: race.betting_opens_at ? new Date(race.betting_opens_at) : null,
    bettingClosesAt: new Date(race.betting_closes_at),
    raceStartsAt: new Date(race.debug_race_starts_at || race.race_starts_at)
  };
}

function ensureNightlyHorseRaces(dateKey, now) {
  const store = horseRaceStore();
  const races = [];
  let changed = false;
  for (const raceTime of HORSE_RACING_CONFIG.raceTimes) {
    let race = store.races.find(candidate =>
      candidate.race_date === dateKey && Number(candidate.race_number || 3) === Number(raceTime.number)
    );
    if (!race) {
      race = createHorseRace(dateKey, raceTime.number, now);
      changed = true;
    } else if (Number(race.schedule_version || 0) < 2 && !race.settled_at) {
      const schedule = getHorseRaceSchedule(dateKey, raceTime.number);
      race.race_number = Number(raceTime.number);
      race.schedule_version = 2;
      race.betting_opens_at = schedule.bettingOpensAt?.toISOString() || null;
      race.betting_closes_at = schedule.bettingClosesAt.toISOString();
      race.race_starts_at = schedule.raceStartsAt.toISOString();
      race.updated_at = now.toISOString();
      changed = true;
    }
    races.push(race);
  }
  return { races, changed };
}

function generateHorseRaceResult(race, now) {
  if (Array.isArray(race.finishing_order) && race.finishing_order.length === race.horse_names.length) return false;
  race.finishing_order = shuffledHorseIds(race.horse_names);
  race.pace_seed = 1 + Math.floor(Math.random() * 2147483646);
  race.race_duration_seconds = randomHorseRaceDurationSeconds();
  race.result_generated_at = now.toISOString();
  race.updated_at = now.toISOString();
  return true;
}

function recordHorseStatsAndOwnerRewards(race, now) {
  if (race.stats_recorded_at) return false;
  const store = horseRaceStore();
  const horsesById = new Map(store.horses.map(horse => [String(horse.id), horse]));
  const raceBets = store.bets.filter(bet => Number(bet.race_id) === Number(race.id));
  const order = Array.isArray(race.finishing_order) ? race.finishing_order : [];

  order.forEach((horseId, index) => {
    const horse = horsesById.get(String(horseId));
    if (!horse) return;
    const position = index + 1;
    horse.races = Number(horse.races || 0) + 1;
    horse.total_finishing_position = Number(horse.total_finishing_position || 0) + position;
    if (position === 1) horse.wins = Number(horse.wins || 0) + 1;
    if (position === 2) horse.second_places = Number(horse.second_places || 0) + 1;

    if (horse.owner_user_id == null) return;
    const wageredOnHorse = raceBets
      .filter(bet => String(bet.horse_id) === String(horse.id))
      .reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
    const betShare = Math.round(wageredOnHorse * Number(store.config.ownerBetSharePercent || 0) / 100);
    const winBonus = position === 1 ? Math.round(Number(store.config.ownerWinBonus || 0)) : 0;
    const amount = betShare + winBonus;
    if (amount <= 0) return;
    store.ownerRewards.push({
      id: store.nextOwnerRewardId++,
      race_id: Number(race.id),
      race_date: race.race_date,
      horse_id: horse.id,
      horse_name: horse.name,
      user_id: Number(horse.owner_user_id),
      finishing_position: position,
      wagered_on_horse: wageredOnHorse,
      bet_share: betShare,
      win_bonus: winBonus,
      amount,
      claimed_at: null,
      claim_transaction_id: null,
      created_at: now.toISOString()
    });
  });

  race.stats_recorded_at = now.toISOString();
  race.owner_rewards_created_at = now.toISOString();
  return true;
}

function revertHorseStatsAndOwnerRewards(race) {
  if (!race.stats_recorded_at) return;
  const store = horseRaceStore();
  const horsesById = new Map(store.horses.map(horse => [String(horse.id), horse]));
  for (const [index, horseId] of (race.finishing_order || []).entries()) {
    const horse = horsesById.get(String(horseId));
    if (!horse) continue;
    const position = index + 1;
    horse.races = Math.max(0, Number(horse.races || 0) - 1);
    horse.total_finishing_position = Math.max(0, Number(horse.total_finishing_position || 0) - position);
    if (position === 1) horse.wins = Math.max(0, Number(horse.wins || 0) - 1);
    if (position === 2) horse.second_places = Math.max(0, Number(horse.second_places || 0) - 1);
  }
  store.ownerRewards = store.ownerRewards.filter(reward => Number(reward.race_id) !== Number(race.id));
  race.stats_recorded_at = null;
  race.owner_rewards_created_at = null;
}

function settleHorseRace(race, now) {
  if (race.settled_at) return false;
  const store = horseRaceStore();
  const order = Array.isArray(race.finishing_order) ? race.finishing_order : [];

  for (const bet of store.bets.filter(candidate => Number(candidate.race_id) === Number(race.id))) {
    if (bet.settled) continue;
    const finishingPosition = order.indexOf(bet.horse_id) + 1;
    const multiplier = Number(HORSE_RACING_CONFIG.payouts[finishingPosition] || 0);
    const payout = Math.round(Number(bet.stake || 0) * multiplier);
    const user = state.users.find(candidate => Number(candidate.id) === Number(bet.user_id));

    bet.finishing_position = finishingPosition || null;
    bet.payout_multiplier = multiplier;
    bet.payout = payout;
    bet.settled = true;
    bet.status = 'settled';
    bet.settled_at = now.toISOString();

    if (user && payout > 0) {
      user.balance = Number(user.balance || 0) + payout;
      state.transactions.push({
        id: state.nextTransactionId++,
        user_id: Number(user.id),
        amount: payout,
        kind: 'casino_horse_racing_payout',
        category: 'casino',
        game: 'horse_racing',
        week: Number(state.settings?.currentWeek || 1),
        race_id: race.id,
        horse_race_bet_id: bet.id,
        note: `Horse racing payout: ${finishingPosition === 1 ? '1st' : '2nd'} place`,
        created_at: now.toISOString()
      });
    }
  }

  recordHorseStatsAndOwnerRewards(race, now);

  race.settled_at = now.toISOString();
  race.updated_at = now.toISOString();
  return true;
}

function effectiveHorseRaceStatus(race, now) {
  const schedule = scheduleForStoredHorseRace(race);
  if (!race.debug_state) {
    return getScheduledHorseRaceStatus(now, schedule, race.race_duration_seconds);
  }

  if (race.debug_state === 'countdown' && now >= schedule.raceStartsAt) {
    race.debug_state = 'racing';
  }
  if (
    race.debug_state === 'racing' &&
    race.race_duration_seconds != null &&
    now.getTime() >= schedule.raceStartsAt.getTime() + Number(race.race_duration_seconds) * 1000
  ) {
    race.debug_state = 'complete';
  }
  return race.debug_state;
}

export function processCurrentHorseRace(now = new Date()) {
  const dateKey = getHorseRaceDateKey(now);
  const nightly = ensureNightlyHorseRaces(dateKey, now);
  const races = nightly.races;
  let changed = nightly.changed;

  for (let index = 0; index < races.length; index += 1) {
    const race = races[index];
    if (index > 0 && !race.betting_opens_at && races[index - 1].status === 'complete') {
      race.betting_opens_at = races[index - 1].settled_at || now.toISOString();
      race.updated_at = now.toISOString();
      changed = true;
    }

    const previousDebugState = race.debug_state;
    const status = effectiveHorseRaceStatus(race, now);
    if (previousDebugState !== race.debug_state) changed = true;
    if (['countdown', 'racing', 'complete'].includes(status)) {
      changed = generateHorseRaceResult(race, now) || changed;
    }
    if (race.status !== status) {
      race.status = status;
      race.updated_at = now.toISOString();
      changed = true;
    }
    if (status === 'complete') changed = settleHorseRace(race, now) || changed;

    const nextRace = races[index + 1];
    if (status === 'complete' && nextRace && !nextRace.betting_opens_at) {
      nextRace.betting_opens_at = race.settled_at || now.toISOString();
      nextRace.updated_at = now.toISOString();
      changed = true;
    }
  }

  if (changed) saveState();
  return races.find(race => race.status !== 'complete') || races.at(-1);
}

function horseRaceBetForUser(raceId, userId) {
  return horseRaceStore().bets.find(bet =>
    Number(bet.race_id) === Number(raceId) && Number(bet.user_id) === Number(userId)
  ) || null;
}

function publicHorseRaceBet(bet) {
  if (!bet) return null;
  return {
    id: bet.id,
    horse_id: bet.horse_id,
    horse_name: bet.horse_name,
    stake: Number(bet.stake || 0),
    payout: bet.payout == null ? null : Number(bet.payout),
    finishing_position: bet.finishing_position == null ? null : Number(bet.finishing_position),
    settled: Boolean(bet.settled),
    updated_at: bet.updated_at || bet.created_at
  };
}

function publicOwnedHorse(horse, rewards = []) {
  const races = Number(horse.races || 0);
  const pendingRewards = rewards.filter(reward => !reward.claimed_at && String(reward.horse_id) === String(horse.id));
  return {
    id: horse.id,
    name: horse.name,
    races,
    wins: Number(horse.wins || 0),
    secondPlaces: Number(horse.second_places || 0),
    averageFinish: races > 0 ? Number((Number(horse.total_finishing_position || 0) / races).toFixed(2)) : null,
    pendingWinnings: pendingRewards.reduce((sum, reward) => sum + Number(reward.amount || 0), 0),
    pendingRewards: pendingRewards.length,
    purchasedAt: horse.created_at || null
  };
}

function syncHorseRaceChatStore(now = new Date()) {
  const store = horseRaceStore();
  const cardDate = getHorseRaceCardDateKey(now);
  if (store.chat.cardDate !== cardDate) {
    store.chat.cardDate = cardDate;
    store.chat.messages = [];
    store.chat.nextMessageId = 1;
    saveState();
  }

  const opensAt = getHorseRaceSchedule(cardDate, 1).bettingOpensAt;
  const cardExists = store.races.some(race => race.race_date === cardDate);
  const lastRace = store.races.find(race =>
    race.race_date === cardDate && Number(race.race_number) === HORSE_RACING_CONFIG.raceTimes.length
  );
  const closesAt = lastRace?.settled_at
    ? new Date(new Date(lastRace.settled_at).getTime() + HORSE_RACING_CONFIG.chatPostRaceMinutes * 60000)
    : null;
  const resetAt = getHorseRaceSchedule(nextDateKey(cardDate), 1).bettingOpensAt;
  const open = cardExists && now >= opensAt && (!closesAt || now < closesAt);
  return { store, cardDate, opensAt, closesAt, resetAt, open };
}

export function getHorseRaceChatState(now = new Date()) {
  processCurrentHorseRace(now);
  const chat = syncHorseRaceChatStore(now);
  return {
    cardDate: chat.cardDate,
    open: chat.open,
    opensAt: chat.opensAt.toISOString(),
    closesAt: chat.closesAt?.toISOString() || null,
    resetAt: chat.resetAt.toISOString(),
    messages: JSON.parse(JSON.stringify(chat.store.chat.messages))
  };
}

export function addHorseRaceChatMessage({ userId, username, message, now = new Date() }) {
  processCurrentHorseRace(now);
  const chat = syncHorseRaceChatStore(now);
  if (!chat.open) throw new Error('Race chat is currently closed.');
  const entry = {
    id: chat.store.chat.nextMessageId++,
    userId: Number(userId),
    username: String(username || `User ${userId}`),
    message: String(message),
    createdAt: now.toISOString()
  };
  chat.store.chat.messages.push(entry);
  saveState();
  return { ...entry };
}

export function buyHorse({ userId, name, now = new Date() }) {
  ensureCasinoState();
  if (!getAdminSettings().casinoOpen) throw new Error('The casino is currently closed.');
  const store = horseRaceStore();
  const ownedHorseCount = store.horses.filter(horse => Number(horse.owner_user_id) === Number(userId)).length;
  if (ownedHorseCount >= HORSE_RACING_CONFIG.maxOwnedHorses) {
    throw new Error(`You can own a maximum of ${HORSE_RACING_CONFIG.maxOwnedHorses} horses.`);
  }
  const cleanName = String(name || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanName.length < 2) throw new Error('Horse name must be at least 2 characters.');
  if (cleanName.length > HORSE_RACING_CONFIG.horseNameMaxLength) {
    throw new Error(`Horse names are limited to ${HORSE_RACING_CONFIG.horseNameMaxLength} characters.`);
  }
  if (store.horses.some(horse => String(horse.name).toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('That horse name is already taken.');
  }
  const user = state.users.find(candidate => Number(candidate.id) === Number(userId));
  if (!user) throw new Error('User not found.');
  const price = Math.ceil(Number(store.config.horsePurchasePrice));
  if (Number(user.balance || 0) < price) throw new Error('Insufficient balance.');

  let id;
  do {
    id = `horse-${store.nextHorseId++}`;
  } while (store.horses.some(horse => String(horse.id) === id));
  const horse = {
    id,
    name: cleanName,
    owner_user_id: Number(userId),
    purchase_price: price,
    races: 0,
    wins: 0,
    second_places: 0,
    total_finishing_position: 0,
    created_at: now.toISOString()
  };
  store.horses.push(horse);
  user.balance = Number(user.balance || 0) - price;
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    amount: -price,
    kind: 'casino_horse_purchase',
    category: 'casino',
    game: 'horse_racing',
    week: Number(state.settings?.currentWeek || 1),
    horse_id: horse.id,
    note: `Purchased horse: ${horse.name}`,
    created_at: now.toISOString()
  });
  saveState();
  return publicOwnedHorse(horse);
}

export function claimHorseOwnerWinnings({ userId, horseId, now = new Date() }) {
  ensureCasinoState();
  const store = horseRaceStore();
  const horse = store.horses.find(candidate =>
    String(candidate.id) === String(horseId) && Number(candidate.owner_user_id) === Number(userId)
  );
  if (!horse) throw new Error('Owned horse not found.');
  const rewards = store.ownerRewards.filter(reward =>
    Number(reward.user_id) === Number(userId) &&
    String(reward.horse_id) === String(horse.id) &&
    !reward.claimed_at
  );
  if (!rewards.length) throw new Error('This horse has no winnings ready to collect.');
  const user = state.users.find(candidate => Number(candidate.id) === Number(userId));
  if (!user) throw new Error('User not found.');

  let total = 0;
  for (const reward of rewards) {
    const amount = Math.round(Number(reward.amount || 0));
    total += amount;
    const transaction = {
      id: state.nextTransactionId++,
      user_id: Number(userId),
      amount,
      kind: 'casino_horse_owner_winnings',
      category: 'casino',
      game: 'horse_racing',
      week: Number(state.settings?.currentWeek || 1),
      race_id: Number(reward.race_id),
      horse_id: horse.id,
      horse_owner_reward_id: reward.id,
      note: `${horse.name} owner winnings: ${reward.bet_share} bet share + ${reward.win_bonus} win bonus`,
      created_at: now.toISOString()
    };
    state.transactions.push(transaction);
    reward.claimed_at = now.toISOString();
    reward.claim_transaction_id = transaction.id;
  }
  user.balance = Number(user.balance || 0) + total;
  saveState();
  return { horseId: horse.id, horseName: horse.name, rewards: rewards.length, amount: total };
}

export function getHorseRaceStateForUser(userId, now = new Date()) {
  const race = processCurrentHorseRace(now);
  const schedule = scheduleForStoredHorseRace(race);
  const status = race.status;
  const userBet = horseRaceBetForUser(race.id, userId);
  const store = horseRaceStore();
  const ownerRewards = store.ownerRewards.filter(reward => Number(reward.user_id) === Number(userId));
  const ownedHorses = store.horses
    .filter(horse => Number(horse.owner_user_id) === Number(userId))
    .map(horse => publicOwnedHorse(horse, ownerRewards))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const chat = syncHorseRaceChatStore(now);
  const cardRaces = store.races
    .filter(candidate => candidate.race_date === race.race_date)
    .sort((a, b) => Number(a.race_number) - Number(b.race_number));
  const horseCareerById = new Map(store.horses.map(horse => [String(horse.id), publicOwnedHorse(horse)]));
  const horseById = Object.fromEntries(race.horse_names.map(horse => [horse.id, horse]));
  const revealOrder = ['racing', 'complete'].includes(status);
  const finishingOrder = revealOrder && Array.isArray(race.finishing_order)
    ? race.finishing_order.map((horseId, index) => ({
      position: index + 1,
      ...horseById[horseId]
    }))
    : null;

  let nextTransitionAt = null;
  if (status === 'upcoming' && !race.debug_state) nextTransitionAt = race.betting_opens_at;
  if (status === 'betting' && !race.debug_state) nextTransitionAt = race.betting_closes_at;
  if (status === 'countdown') nextTransitionAt = schedule.raceStartsAt.toISOString();
  if (status === 'racing') {
    nextTransitionAt = new Date(
      schedule.raceStartsAt.getTime() + Number(race.race_duration_seconds || 0) * 1000
    ).toISOString();
  }

  return {
    serverNow: now.toISOString(),
    isCasinoOpen: getAdminSettings().casinoOpen,
    race: {
      id: race.id,
      date: race.race_date,
      number: Number(race.race_number || 1),
      status,
      isDebug: Boolean(race.debug_state),
      horses: race.horse_names.map(horse => {
        const career = horseCareerById.get(String(horse.id));
        return {
          ...horse,
          image: race.horse_image,
          career: {
            races: Number(career?.races || 0),
            wins: Number(career?.wins || 0),
            averageFinish: career?.averageFinish ?? null
          }
        };
      }),
      bettingOpensAt: race.betting_opens_at,
      bettingClosesAt: race.betting_closes_at,
      raceStartsAt: schedule.raceStartsAt.toISOString(),
      raceDurationSeconds: race.race_duration_seconds,
      nextTransitionAt,
      finishingOrder,
      paceSeed: Number(race.pace_seed || race.id),
      resultGeneratedAt: race.result_generated_at,
      settledAt: race.settled_at
    },
    card: {
      raceCount: HORSE_RACING_CONFIG.raceTimes.length,
      races: cardRaces.map(candidate => ({
        id: candidate.id,
        number: Number(candidate.race_number),
        status: candidate.status,
        bettingOpensAt: candidate.betting_opens_at,
        bettingClosesAt: candidate.betting_closes_at,
        raceStartsAt: candidate.race_starts_at
      }))
    },
    config: {
      timeZone: HORSE_RACING_CONFIG.timeZone,
      maxBet: store.config.maxBet,
      payouts: HORSE_RACING_CONFIG.payouts,
      countdownSeconds: HORSE_RACING_CONFIG.countdownSeconds,
      raceDurationMinSeconds: HORSE_RACING_CONFIG.raceDurationMinSeconds,
      raceDurationMaxSeconds: HORSE_RACING_CONFIG.raceDurationMaxSeconds,
      chatMaxLength: HORSE_RACING_CONFIG.chatMaxLength,
      chatPostRaceMinutes: HORSE_RACING_CONFIG.chatPostRaceMinutes
    },
    horseOwnership: {
      purchasePrice: store.config.horsePurchasePrice,
      ownerBetSharePercent: store.config.ownerBetSharePercent,
      ownerWinBonus: store.config.ownerWinBonus,
      maxOwnedHorses: HORSE_RACING_CONFIG.maxOwnedHorses,
      nameMaxLength: HORSE_RACING_CONFIG.horseNameMaxLength,
      ownedHorses,
      pendingWinnings: ownedHorses.reduce((sum, horse) => sum + Number(horse.pendingWinnings || 0), 0)
    },
    userBet: publicHorseRaceBet(userBet),
    balanceSummary: getBalanceSummaryForUser(userId),
    chatOpen: chat.open,
    chatClosesAt: chat.closesAt?.toISOString() || null,
    chatResetAt: chat.resetAt.toISOString()
  };
}

export function placeOrUpdateHorseRaceBet({ userId, horseId, stake, now = new Date() }) {
  if (!getAdminSettings().casinoOpen) throw new Error('The casino is currently closed.');
  const race = processCurrentHorseRace(now);
  if (race.status !== 'betting') throw new Error('Horse race betting is not open.');

  const cleanStake = Number(stake);
  if (!Number.isInteger(cleanStake) || cleanStake <= 0) throw new Error('Stake must be a positive whole number.');
  const maxBet = Number(horseRaceStore().config.maxBet);
  if (cleanStake > maxBet) {
    throw new Error(`Max horse race bet is ${maxBet} Mushybux.`);
  }

  const horse = race.horse_names.find(candidate => candidate.id === String(horseId));
  if (!horse) throw new Error('Select a valid horse.');
  const user = state.users.find(candidate => Number(candidate.id) === Number(userId));
  if (!user) throw new Error('User not found.');

  const existing = horseRaceBetForUser(race.id, userId);
  if (existing?.settled) throw new Error('This wager has already been settled.');
  const oldStake = Number(existing?.stake || 0);
  const available = Number(user.balance || 0) + oldStake;
  if (available < cleanStake) throw new Error('Insufficient balance.');
  user.balance = available - cleanStake;

  if (existing) {
    existing.horse_id = horse.id;
    existing.horse_name = horse.name;
    existing.stake = cleanStake;
    existing.updated_at = now.toISOString();
    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: Number(userId),
      amount: oldStake - cleanStake,
      kind: 'casino_horse_racing_bet_change',
      category: 'casino',
      game: 'horse_racing',
      week: Number(state.settings?.currentWeek || 1),
      race_id: race.id,
      horse_race_bet_id: existing.id,
      note: `Horse race wager changed: ${horse.name}`,
      created_at: now.toISOString()
    });
    saveState();
    return { action: 'updated', bet: publicHorseRaceBet(existing) };
  }

  const store = horseRaceStore();
  const bet = {
    id: store.nextBetId++,
    race_id: race.id,
    user_id: Number(userId),
    horse_id: horse.id,
    horse_name: horse.name,
    stake: cleanStake,
    payout: null,
    payout_multiplier: null,
    finishing_position: null,
    settled: false,
    status: 'open',
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  store.bets.push(bet);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    amount: -cleanStake,
    kind: 'casino_horse_racing_wager',
    category: 'casino',
    game: 'horse_racing',
    week: Number(state.settings?.currentWeek || 1),
    race_id: race.id,
    horse_race_bet_id: bet.id,
    note: `Horse race wager: ${horse.name}`,
    created_at: now.toISOString()
  });
  saveState();
  return { action: 'placed', bet: publicHorseRaceBet(bet) };
}

export function controlCurrentHorseRace(action, now = new Date()) {
  const race = processCurrentHorseRace(now);
  const store = horseRaceStore();
  const command = String(action || '').toLowerCase();

  if (command === 'reset') {
    const raceTransactions = state.transactions.filter(transaction =>
      transaction.game === 'horse_racing' && Number(transaction.race_id) === Number(race.id)
    );
    const netByUser = new Map();
    for (const transaction of raceTransactions) {
      const uid = Number(transaction.user_id);
      netByUser.set(uid, (netByUser.get(uid) || 0) + Number(transaction.amount || 0));
    }
    for (const [uid, net] of netByUser) {
      const user = state.users.find(candidate => Number(candidate.id) === uid);
      if (user) user.balance = Number(user.balance || 0) - net;
    }
    state.transactions = state.transactions.filter(transaction =>
      !(transaction.game === 'horse_racing' && Number(transaction.race_id) === Number(race.id))
    );
    store.bets = store.bets.filter(bet => Number(bet.race_id) !== Number(race.id));
    revertHorseStatsAndOwnerRewards(race);
    race.finishing_order = null;
    race.pace_seed = null;
    race.race_duration_seconds = null;
    race.result_generated_at = null;
    race.settled_at = null;
    race.debug_state = 'upcoming';
    race.debug_race_starts_at = null;
    race.status = 'upcoming';
  } else {
    if (race.settled_at) throw new Error('Reset the completed race before running another debug command.');
    if (command === 'open') {
      race.debug_state = 'betting';
      race.debug_race_starts_at = null;
      race.status = 'betting';
    } else if (command === 'close') {
      generateHorseRaceResult(race, now);
      race.debug_state = 'countdown';
      race.debug_race_starts_at = new Date(
        now.getTime() + HORSE_RACING_CONFIG.countdownSeconds * 1000
      ).toISOString();
      race.status = 'countdown';
    } else if (command === 'start') {
      generateHorseRaceResult(race, now);
      race.debug_state = 'racing';
      race.debug_race_starts_at = now.toISOString();
      race.status = 'racing';
    } else {
      throw new Error('Unknown horse race debug command.');
    }
  }

  race.updated_at = now.toISOString();
  saveState();
  return { action: command, raceId: race.id, status: race.status };
}




const CASINO_SLOT_WAGERS = [10, 20, 30, 40, 50];
const CASINO_MAX_SLOT_WAGER = 50;
const CASINO_JACKPOT_CONTRIBUTION_RATE = 0.10;

const CASINO_SLOT_OUTCOMES = [
  { key: 'loss', label: 'Loss', weight: 62200, multiplier: 0, kind: 'loss' },
  { key: 'd3_pair', label: 'D3 Logo Pair', weight: 18000, multiplier: 1.0, tier: 'd3', matchCount: 2 },
  { key: 'd2_pair', label: 'D2 Logo Pair', weight: 6867, multiplier: 1.5, tier: 'd2', matchCount: 2 },
  { key: 'd1_pair', label: 'D1 Logo Pair', weight: 5100, multiplier: 2, tier: 'd1', matchCount: 2 },
  { key: 'wcpl_pair', label: 'WCPL Pair', weight: 2083, multiplier: 3, tier: 'wcpl', matchCount: 2 },
  { key: 'mushy_pair', label: 'Mushy Pair', weight: 1000, multiplier: 5, tier: 'mushy', matchCount: 2 },
  { key: 'd3_triple', label: 'D3 Logo Triple', weight: 2400, multiplier: 2.5, tier: 'd3', matchCount: 3 },
  { key: 'd2_triple', label: 'D2 Logo Triple', weight: 1500, multiplier: 5, tier: 'd2', matchCount: 3 },
  { key: 'd1_triple', label: 'D1 Logo Triple', weight: 600, multiplier: 10, tier: 'd1', matchCount: 3 },
  { key: 'wcpl_triple', label: 'WCPL Triple', weight: 150, multiplier: 25, tier: 'wcpl', matchCount: 3 },
  { key: 'mushy_jackpot', label: 'Mushy Jackpot', weight: 100, multiplier: 10, tier: 'mushy', matchCount: 3, jackpot: true }
];

const CASINO_SYMBOL_POOLS = {
  mushy: [
    { id: 'mushy', label: 'Mushy', image: '/images/casino/mushy.png', tier: 'mushy' }
  ],
  wcpl: [
    { id: 'wcpl', label: 'WCPL', image: '/images/casino/wcpl.png', tier: 'wcpl' }
  ],
  d3: [
    { id: '206', label: 'Seattle Thunderbirds', image: '/images/casino/D3/206.png', tier: 'd3' },
    { id: 'cgy', label: 'Calgary Hitmen', image: '/images/casino/D3/CGY.png', tier: 'd3' },
    { id: 'evt', label: 'Everett Silvertips', image: '/images/casino/D3/EVT.png', tier: 'd3' },
    { id: 'kln', label: 'Kelowna Rockets', image: '/images/casino/D3/KLN.png', tier: 'd3' },
    { id: 'van', label: 'Vancouver Giants', image: '/images/casino/D3/VAN.png', tier: 'd3' },
    { id: 'vic', label: 'Victoria Royals', image: '/images/casino/D3/VIC.png', tier: 'd3' }
  ],
  d1: [
    { id: 'bcl', label: 'BC Legless', image: '/images/casino/D1/BCL.png', tier: 'd1' },
    { id: 'll', label: 'Little St. James Lot Lizards', image: '/images/casino/D1/LL.png', tier: 'd1' },
    { id: 'nk', label: 'Niagra Nicks', image: '/images/casino/D1/NK.png', tier: 'd1' },
    { id: 'pkn', label: 'Puckin Penguins', image: '/images/casino/D1/PKN.png', tier: 'd1' },
    { id: 'sea', label: 'Summer Seals', image: '/images/casino/D1/SEA.png', tier: 'd1' },
    { id: 'tor', label: 'Toronto Badgers', image: '/images/casino/D1/TOR.png', tier: 'd1' }
  ],
  d2: [
    { id: 'bck', label: 'Bucktown', image: '/images/casino/D2/BCK.png', tier: 'd2' },
    { id: 'bld', label: 'San Jose Blades', image: '/images/casino/D2/BLD.png', tier: 'd2' },
    { id: 'blm', label: 'Bloomin Onions', image: '/images/casino/D2/BLM.png', tier: 'd2' },
    { id: 'cle', label: 'Cleveland Spiders', image: '/images/casino/D2/CLE.png', tier: 'd2' },
    { id: 'lgt', label: 'Lethbridge Light-Weights', image: '/images/casino/D2/LGT.png', tier: 'd2' },
    { id: 'rch', label: 'Richmond Drivers', image: '/images/casino/D2/RCH.png', tier: 'd2' }
  ]
};

const CASINO_ALL_SYMBOLS = Object.values(CASINO_SYMBOL_POOLS).flat();

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function pickSlotOutcome(wager = CASINO_MAX_SLOT_WAGER) {
  // Keep normal pair/triple odds the same for every wager, but scale the rare jackpot
  // chance by wager so the fixed jackpot seed does not make small spins better EV.
  const wagerScale = Math.max(0, Math.min(1, Number(wager || 0) / CASINO_MAX_SLOT_WAGER));
  const baseJackpotWeight = CASINO_SLOT_OUTCOMES
    .filter(o => o.jackpot)
    .reduce((sum, o) => sum + Number(o.weight || 0), 0);

  const scaledJackpotWeight = Math.round(baseJackpotWeight * wagerScale);
  const removedJackpotWeight = baseJackpotWeight - scaledJackpotWeight;

  const adjustedOutcomes = CASINO_SLOT_OUTCOMES.map(o => {
    if (o.jackpot) {
      return { ...o, weight: Math.round(Number(o.weight || 0) * wagerScale) };
    }
    if (o.kind === 'loss') {
      return { ...o, weight: Number(o.weight || 0) + removedJackpotWeight };
    }
    return o;
  });

  const totalWeight = adjustedOutcomes.reduce((sum, o) => sum + Number(o.weight || 0), 0);
  let roll = Math.floor(Math.random() * totalWeight) + 1;
  for (const outcome of adjustedOutcomes) {
    roll -= Number(outcome.weight || 0);
    if (roll <= 0) return outcome;
  }
  return adjustedOutcomes[0];
}

function buildWinningReels(outcome) {
  const match = pickRandom(CASINO_SYMBOL_POOLS[outcome.tier] || CASINO_SYMBOL_POOLS.d3);
  if (Number(outcome.matchCount) === 3) return [match, match, match];

  const others = CASINO_ALL_SYMBOLS.filter(s => s.id !== match.id);
  const miss = pickRandom(others);
  const reels = [match, match, miss];
  for (let i = reels.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [reels[i], reels[j]] = [reels[j], reels[i]];
  }
  return reels;
}

function buildLosingReels() {
  const symbols = [...CASINO_ALL_SYMBOLS];
  const reels = [];
  while (reels.length < 3 && symbols.length) {
    const index = Math.floor(Math.random() * symbols.length);
    reels.push(symbols.splice(index, 1)[0]);
  }
  return reels;
}

export function getCasinoSummary() {
  ensureCasinoState();
  const slotWagered = state.casino.spins.reduce(
    (sum, spin) => sum + Number(spin.wager || 0),
    0
  );
  const slotPaid = state.casino.spins.reduce(
    (sum, spin) => sum + Number(spin.payout || 0),
    0
  );
  const puckIqWagered = state.casino.shotDoctorRuns.reduce(
    (sum, run) => sum + Number(run.wager || 0),
    0
  );
  const puckIqPaid = state.casino.shotDoctorRuns.reduce(
    (sum, run) => sum + Number(run.payout || 0),
    0
  );
  const horseRacingWagered = state.casino.horseRacing.bets.reduce(
    (sum, bet) => sum + Number(bet.stake || 0),
    0
  );
  const horseRacingPaid = state.casino.horseRacing.bets.reduce(
    (sum, bet) => sum + Number(bet.payout || 0),
    0
  );
  const horseOwnerPaid = state.casino.horseRacing.ownerRewards
    .filter(reward => reward.claimed_at)
    .reduce((sum, reward) => sum + Number(reward.amount || 0), 0);
  const totalWagered = slotWagered + puckIqWagered + horseRacingWagered;
  const totalPaid = slotPaid + puckIqPaid + horseRacingPaid + horseOwnerPaid;

  return {
    totalWagered,
    totalPaid,
    netProfit: totalPaid - totalWagered,
    slotSpins: state.casino.spins.length,
    puckIqRuns: state.casino.shotDoctorRuns.length,
    horseRacingBets: state.casino.horseRacing.bets.length,
    horseRacingConfig: getHorseRacingConfig()
  };
}

export function resetCasinoData() {
  ensureCasinoState();
  const horseRacingConfig = { ...state.casino.horseRacing.config };
  const casinoTransactions = state.transactions.filter(
    transaction => transaction.category === 'casino'
  );
  const netByUser = new Map();

  for (const transaction of casinoTransactions) {
    const userId = Number(transaction.user_id);
    netByUser.set(
      userId,
      (netByUser.get(userId) || 0) + Number(transaction.amount || 0)
    );
  }

  for (const [userId, casinoNet] of netByUser.entries()) {
    const user = state.users.find(candidate => Number(candidate.id) === userId);
    if (user) user.balance = Number(user.balance || 0) - casinoNet;
  }

  const seed = Number(process.env.CASINO_JACKPOT_SEED || 1000);
  state.casino = {
    jackpotAmount: seed,
    jackpotSeed: seed,
    totalWagered: 0,
    totalPaid: 0,
    spins: [],
    shotDoctorRuns: [],
    horseRacing: { config: horseRacingConfig }
  };
  state.transactions = state.transactions.filter(
    transaction => transaction.category !== 'casino'
  );
  state.nextCasinoSpinId = 1;
  state.nextShotDoctorRunId = 1;
  saveState();

  return {
    transactionsRemoved: casinoTransactions.length,
    usersRestored: netByUser.size
  };
}

export function getCasinoStateForUser(userId = null) {
  ensureCasinoState();

  const wageredByUser = new Map();
  for (const spin of state.casino.spins) {
    const uid = Number(spin.user_id);
    const current = wageredByUser.get(uid) || { totalWagered: 0, spins: 0 };
    current.totalWagered += Number(spin.wager || 0);
    current.spins += 1;
    wageredByUser.set(uid, current);
  }

  const slotLeaderboard = [...wageredByUser.entries()]
    .map(([uid, totals]) => {
      const user = state.users.find(u => Number(u.id) === Number(uid));
      return {
        user_id: uid,
        user_display_name: user?.display_name || `User ${uid}`,
        total_wagered: totals.totalWagered,
        spins: totals.spins
      };
    })
    .sort((a, b) => Number(b.total_wagered || 0) - Number(a.total_wagered || 0));
  const slotSummary = {
    total_wagered: slotLeaderboard.reduce(
      (sum, row) => sum + Number(row.total_wagered || 0),
      0
    ),
    total_spins: slotLeaderboard.reduce(
      (sum, row) => sum + Number(row.spins || 0),
      0
    )
  };

  return {
    isOpen: getAdminSettings().casinoOpen,
    jackpotAmount: Math.floor(Number(state.casino.jackpotAmount || 0)),
    jackpotSeed: Math.floor(Number(state.casino.jackpotSeed || 0)),
    contributionRate: CASINO_JACKPOT_CONTRIBUTION_RATE,
    allowedWagers: [...CASINO_SLOT_WAGERS],
    slotLeaderboard,
    slotSummary,
    allSymbols: CASINO_ALL_SYMBOLS,
    balanceSummary: userId ? getBalanceSummaryForUser(userId) : null
  };
}

export function spinCasinoSlots({ userId, wager }) {
  ensureCasinoState();
  if (!getAdminSettings().casinoOpen) throw new Error('The casino is currently closed.');
  const cleanWager = Number(wager);
  if (!CASINO_SLOT_WAGERS.includes(cleanWager)) throw new Error('Select a valid spin amount.');

  const user = state.users.find(u => Number(u.id) === Number(userId));
  if (!user) throw new Error('User not found.');
  if (Number(user.balance || 0) < cleanWager) throw new Error('Insufficient balance.');

  const jackpotBefore = Math.floor(Number(state.casino.jackpotAmount || state.casino.jackpotSeed || 1000));
  const jackpotContribution = Math.round(cleanWager * CASINO_JACKPOT_CONTRIBUTION_RATE);
  const outcome = pickSlotOutcome(cleanWager);
  const reels = outcome.kind === 'loss' ? buildLosingReels() : buildWinningReels(outcome);

  let payout = 0;
  if (outcome.jackpot) {
    payout = jackpotBefore + jackpotContribution + Math.round(cleanWager * Number(outcome.multiplier || 0));
    state.casino.jackpotAmount = Number(state.casino.jackpotSeed || 1000);
  } else {
    payout = Math.round(cleanWager * Number(outcome.multiplier || 0));
    state.casino.jackpotAmount = jackpotBefore + jackpotContribution;
  }

  const net = payout - cleanWager;
  user.balance = Number(user.balance || 0) - cleanWager + payout;

  state.casino.totalWagered = Number(state.casino.totalWagered || 0) + cleanWager;
  state.casino.totalPaid = Number(state.casino.totalPaid || 0) + payout;

  const spin = {
    id: state.nextCasinoSpinId++,
    user_id: Number(userId),
    game: 'slots',
    week: Number(state.settings?.currentWeek || 1),
    wager: cleanWager,
    payout,
    net,
    outcome_key: outcome.key,
    outcome_label: outcome.label,
    multiplier: Number(outcome.multiplier || 0),
    jackpot: Boolean(outcome.jackpot),
    jackpot_before: jackpotBefore,
    jackpot_after: Math.floor(Number(state.casino.jackpotAmount || 0)),
    jackpot_contribution: jackpotContribution,
    reels,
    created_at: nowIso()
  };

  state.casino.spins.push(spin);

  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    amount: -cleanWager,
    kind: 'casino_slots_wager',
    category: 'casino',
    game: 'slots',
    week: Number(state.settings?.currentWeek || 1),
    note: `Slots wager (${outcome.label})`,
    casino_spin_id: spin.id,
    created_at: nowIso()
  });

  if (payout > 0) {
    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: Number(userId),
      amount: payout,
      kind: outcome.jackpot ? 'casino_jackpot_payout' : 'casino_slots_payout',
      category: 'casino',
      game: 'slots',
      week: Number(state.settings?.currentWeek || 1),
      note: outcome.jackpot ? `Mushy Jackpot won: ${payout}` : `Slots payout: ${outcome.label}`,
      casino_spin_id: spin.id,
      created_at: nowIso()
    });
  }

  saveState();

  return {
    ...spin,
    balanceSummary: getBalanceSummaryForUser(user.id),
    jackpotAmount: Math.floor(Number(state.casino.jackpotAmount || 0))
  };
}


const SHOT_DOCTOR_SECONDS_PER_SHOT = Number(process.env.SHOT_DOCTOR_SECONDS_PER_SHOT || 15);
const SHOT_DOCTOR_WEEKLY_LIMIT = Number(process.env.SHOT_DOCTOR_WEEKLY_LIMIT || 5);
const SHOT_DOCTOR_PAYOUTS = {
  0: 0,
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 25,
  6: 50,
  7: 75,
  8: 100,
  9: 200,
  10: 500
};

function publicShotDoctorRun(run) {
  if (!run) return null;
  const currentIndex = Number(run.current_index || 0);
  const currentShot = Array.isArray(run.shots) ? run.shots[currentIndex] : null;
  const shotStartedAt = run.current_shot_started_at || null;
  const deadlineAt = shotStartedAt
    ? new Date(new Date(shotStartedAt).getTime() + SHOT_DOCTOR_SECONDS_PER_SHOT * 1000).toISOString()
    : null;

  return {
    id: run.id,
    user_id: run.user_id,
    game: 'shot_doctor',
    status: run.status,
    wager: Number(run.wager || 0),
    payout: Number(run.payout || 0),
    net: Number(run.net || 0),
    correct: Number(run.correct || 0),
    current_index: currentIndex,
    total_shots: Array.isArray(run.shots) ? run.shots.length : 0,
    guesses: Array.isArray(run.guesses) ? run.guesses.map(g => ({
      index: g.index,
      guess: g.guess,
      result: g.result,
      correct: Boolean(g.correct),
      timed_out: Boolean(g.timed_out)
    })) : [],
    current_shot: currentShot && run.status === 'active' ? publicShotDoctorShot(currentShot) : null,
    shot_started_at: shotStartedAt,
    deadline_at: deadlineAt,
    seconds_per_shot: SHOT_DOCTOR_SECONDS_PER_SHOT,
    created_at: run.created_at,
    completed_at: run.completed_at || null
  };
}

function publicShotDoctorShot(shot) {
  if (!shot) return null;
  return {
    shooter_name: shot.shooter_name,
    goalie_name: shot.goalie_name,
    shot_type: shot.shot_type,
    speed_kmh: Number(shot.speed_kmh || 0),
    distance_m: Number(shot.distance_m || 0),
    x: Number(shot.x || 0),
    z: Number(shot.z || 0),
    xg: shot.xg == null ? null : Number(shot.xg)
  };
}

function getActiveShotDoctorRunForUser(userId) {
  ensureCasinoState();
  return state.casino.shotDoctorRuns.find(r =>
    Number(r.user_id) === Number(userId) && r.status === 'active'
  ) || null;
}

function getShotDoctorLeaderboard() {
  ensureCasinoState();

  const byUser = new Map();

  for (const run of state.casino.shotDoctorRuns || []) {
    const uid = Number(run.user_id);
    if (!uid) continue;

    if (!byUser.has(uid)) {
      const user = state.users.find(u => Number(u.id) === uid) || {};
      byUser.set(uid, {
        user_id: uid,
        display_name: String(user.display_name || user.username || `User ${uid}`),
        runs_completed: 0,
        total_correct: 0,
        total_wagered: 0
      });
    }

    const row = byUser.get(uid);
    row.total_wagered += Number(run.wager || 0);

    if (run.status === 'complete') {
      row.runs_completed += 1;
      row.total_correct += Number(run.correct || 0);
    }
  }

  return [...byUser.values()]
    .filter(r => r.runs_completed > 0 || r.total_wagered > 0)
    .map(r => ({
      ...r,
      average_score: r.runs_completed > 0 ? r.total_correct / r.runs_completed : 0
    }))
    .sort((a, b) =>
      (b.average_score - a.average_score) ||
      (b.total_wagered - a.total_wagered) ||
      String(a.display_name).localeCompare(String(b.display_name))
    );
}

function getShotDoctorLeaderboardSummary() {
  ensureCasinoState();
  const completedRuns = state.casino.shotDoctorRuns.filter(
    run => run.status === 'complete'
  );
  const totalCorrect = completedRuns.reduce(
    (sum, run) => sum + Number(run.correct || 0),
    0
  );
  return {
    average_score: completedRuns.length ? totalCorrect / completedRuns.length : 0,
    total_wagered: state.casino.shotDoctorRuns.reduce(
      (sum, run) => sum + Number(run.wager || 0),
      0
    )
  };
}


function getShotDoctorRunsUsedThisWeek(userId) {
  ensureCasinoState();
  const currentWeek = Number(state.settings?.currentWeek || 1);
  return (state.casino.shotDoctorRuns || []).filter(r =>
    Number(r.user_id) === Number(userId) &&
    Number(r.week || currentWeek) === currentWeek
  ).length;
}

export function getShotDoctorStateForUser(userId) {
  ensureCasinoState();
  const userRuns = state.casino.shotDoctorRuns
    .filter(r => Number(r.user_id) === Number(userId))
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

  const activeRun = userRuns.find(r => r.status === 'active') || null;
  const weeklyRunsUsed = userId ? getShotDoctorRunsUsedThisWeek(userId) : 0;
  const weeklyRunsRemaining = SHOT_DOCTOR_WEEKLY_LIMIT > 0
    ? Math.max(0, SHOT_DOCTOR_WEEKLY_LIMIT - weeklyRunsUsed)
    : null;

  return {
    isOpen: getAdminSettings().casinoOpen,
    entryFee: Number(process.env.SHOT_DOCTOR_ENTRY_FEE || 50),
    shotsPerRun: 10,
    secondsPerShot: SHOT_DOCTOR_SECONDS_PER_SHOT,
    weeklyLimit: SHOT_DOCTOR_WEEKLY_LIMIT,
    weeklyRunsUsed,
    weeklyRunsRemaining,
    payouts: SHOT_DOCTOR_PAYOUTS,
    activeRun: publicShotDoctorRun(activeRun),
    leaderboard: getShotDoctorLeaderboard(),
    leaderboardSummary: getShotDoctorLeaderboardSummary(),
    balanceSummary: userId ? getBalanceSummaryForUser(userId) : null
  };
}

export function startShotDoctorRun({ userId, shots, wager }) {
  ensureCasinoState();
  if (!getAdminSettings().casinoOpen) throw new Error('The casino is currently closed.');
  const cleanWager = Number(wager || process.env.SHOT_DOCTOR_ENTRY_FEE || 50);
  if (!Number.isFinite(cleanWager) || cleanWager <= 0) throw new Error('Invalid entry fee.');
  if (!Array.isArray(shots) || shots.length !== 10) throw new Error('Puck IQ needs exactly 10 shots.');

  const existing = getActiveShotDoctorRunForUser(userId);
  if (existing) throw new Error('Finish your current Puck IQ run before starting another.');

  const usedThisWeek = getShotDoctorRunsUsedThisWeek(userId);
  if (SHOT_DOCTOR_WEEKLY_LIMIT > 0 && usedThisWeek >= SHOT_DOCTOR_WEEKLY_LIMIT) {
    throw new Error('You have used all of your Puck IQ runs for this week.');
  }

  const user = state.users.find(u => Number(u.id) === Number(userId));
  if (!user) throw new Error('User not found.');
  if (Number(user.balance || 0) < cleanWager) throw new Error('Insufficient balance.');

  user.balance = Number(user.balance || 0) - cleanWager;

  const run = {
    id: state.nextShotDoctorRunId++,
    user_id: Number(userId),
    game: 'shot_doctor',
    week: Number(state.settings?.currentWeek || 1),
    status: 'active',
    wager: cleanWager,
    payout: 0,
    net: -cleanWager,
    correct: 0,
    current_index: 0,
    shots,
    guesses: [],
    current_shot_started_at: nowIso(),
    created_at: nowIso(),
    completed_at: null
  };

  state.casino.shotDoctorRuns.push(run);
  state.transactions.push({
    id: state.nextTransactionId++,
    user_id: Number(userId),
    amount: -cleanWager,
    kind: 'casino_shot_doctor_entry',
    category: 'casino',
    game: 'shot_doctor',
    week: Number(state.settings?.currentWeek || 1),
    note: 'Puck IQ entry',
    shot_doctor_run_id: run.id,
    created_at: nowIso()
  });

  saveState();
  return {
    run: publicShotDoctorRun(run),
    balanceSummary: getBalanceSummaryForUser(user.id)
  };
}

export function submitShotDoctorGuess({ userId, runId, guess }) {
  ensureCasinoState();
  if (!getAdminSettings().casinoOpen) throw new Error('The casino is currently closed.');
  const run = state.casino.shotDoctorRuns.find(r =>
    Number(r.id) === Number(runId) && Number(r.user_id) === Number(userId)
  );
  if (!run) throw new Error('Puck IQ run not found.');
  if (run.status !== 'active') throw new Error('This Puck IQ run is already complete.');

  const idx = Number(run.current_index || 0);
  const shot = Array.isArray(run.shots) ? run.shots[idx] : null;
  if (!shot) throw new Error('No active shot found.');

  const cleanGuess = String(guess || '').trim().toUpperCase();
  const isTimeoutGuess = cleanGuess === 'TIMEOUT';
  if (!isTimeoutGuess && cleanGuess !== 'G' && cleanGuess !== 'S') {
    throw new Error('Guess must be Goal or Save.');
  }

  const startedAt = new Date(run.current_shot_started_at || run.created_at || nowIso()).getTime();
  const nowMs = Date.now();
  const timedOut = !Number.isFinite(startedAt) || nowMs > (startedAt + SHOT_DOCTOR_SECONDS_PER_SHOT * 1000 + 750);
  const result = String(shot.result || '').trim().toUpperCase();
  const correct = !timedOut && !isTimeoutGuess && cleanGuess === result;

  if (correct) run.correct = Number(run.correct || 0) + 1;

  const reveal = {
    index: idx,
    guess: isTimeoutGuess || timedOut ? '' : cleanGuess,
    result,
    correct,
    timed_out: timedOut || isTimeoutGuess,
    shot: publicShotDoctorShot(shot),
    answered_at: nowIso()
  };

  run.guesses.push(reveal);
  run.current_index = idx + 1;

  if (run.current_index >= run.shots.length) {
    run.status = 'complete';
    const correctCount = Number(run.correct || 0);
    const payout = Number(SHOT_DOCTOR_PAYOUTS[correctCount] || 0);
    run.payout = payout;
    run.net = payout - Number(run.wager || 0);
    run.completed_at = nowIso();
    run.current_shot_started_at = null;

    const user = state.users.find(u => Number(u.id) === Number(userId));
    if (user && payout > 0) {
      user.balance = Number(user.balance || 0) + payout;
      state.transactions.push({
        id: state.nextTransactionId++,
        user_id: Number(userId),
        amount: payout,
        kind: 'casino_shot_doctor_payout',
        category: 'casino',
        game: 'shot_doctor',
        week: Number(run.week || state.settings?.currentWeek || 1),
        note: `Puck IQ payout: ${correctCount}/10 correct`,
        shot_doctor_run_id: run.id,
        created_at: nowIso()
      });
    }
  } else {
    run.current_shot_started_at = nowIso();
  }

  saveState();

  return {
    reveal,
    run: publicShotDoctorRun(run),
    balanceSummary: getBalanceSummaryForUser(userId)
  };
}

export function getUserSettledBetHistory(userId, limit = 200) {
  return state.bets
    .filter(b => b.user_id === Number(userId) && b.status === 'settled')
    .map(b => {
      const stake = Number(b.stake || 0);
      const payout = Number(b.payout || 0);
      const net = payout - stake;
      return {
        id: b.id,
        week: Number(b.week || 0),
        label: b.label,
        bet_kind: b.bet_kind || 'series',
        stake,
        multiplier: Number(b.multiplier || 0),
        payout,
        net,
        net_display: net > 0 ? `+${net}` : String(net),
        result: b.won ? 'Win' : 'Loss',
        won: Boolean(b.won),
        result_summary: b.result_summary || '',
        settled_at: b.settled_at || ''
      };
    })
    .sort((a, b) => String(b.settled_at).localeCompare(String(a.settled_at)) || b.week - a.week || b.id - a.id)
    .slice(0, limit);
}

function safeUser(user) {
  const { password_hash, ...safe } = user;
  return { ...safe };
}
