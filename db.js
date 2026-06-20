import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';

const dbPath = path.resolve(process.env.JSON_DB_PATH || './betting.json');
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'));

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
      seasonId: process.env.SEASON_ID || 'S3'
    },
    users: [],
    bets: [],
    transactions: [],
    oddsAdjustments: {
      series: {},
      goalTotals: {},
      propDefaults: {},
      propPlayerOverrides: {}
    },
    casino: {
      jackpotAmount: Number(process.env.CASINO_JACKPOT_SEED || 1000),
      jackpotSeed: Number(process.env.CASINO_JACKPOT_SEED || 1000),
      totalWagered: 0,
      totalPaid: 0,
      spins: []
    },
    nextUserId: 1,
    nextBetId: 1,
    nextTransactionId: 1,
    nextCasinoSpinId: 1
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
    ...(state.settings || {})
  };
  state.settings.currentWeek = Number(state.settings.currentWeek || 1);
  state.settings.weeklyAllowance = Number(state.settings.weeklyAllowance || 100);
  state.settings.seasonId = String(state.settings.seasonId || process.env.SEASON_ID || 'S3');

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
  state.nextCasinoSpinId = Number(state.nextCasinoSpinId || 1);
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

  const startingBalance = Number(process.env.STARTING_BALANCE || 1000);
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

export function getLeaderboard(currentWeek = null) {
  const weekNum = Number(currentWeek ?? state.settings?.currentWeek ?? 1);

  return state.users
    .map(user => {
      const openWagered = getOpenWageredForUser(user.id);
      const totalBalance = Number(user.balance || 0) + openWagered;
      return {
        id: user.id,
        display_name: user.display_name,
        username: user.username,
        balance: user.balance,
        open_wagered: openWagered,
        total_balance: totalBalance,
        balance_display: formatBalanceDisplay(totalBalance, openWagered),
        last_week_change: getSettledBetNetForUser(user.id, weekNum - 1),
        current_week_change: getSettledBetNetForUser(user.id, weekNum)
      };
    })
    .sort((a, b) => b.total_balance - a.total_balance || a.display_name.localeCompare(b.display_name));
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
  category,
  playerKey,
  playerName,
  playerTeamId = '',
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
    existingBet.market_key = propKey;
    existingBet.market_type = category;
    existingBet.prop_category = category;
    existingBet.player_key = playerKey;
    existingBet.player_name = playerName;
    existingBet.player_team_id = String(playerTeamId || existingBet.player_team_id || '');
    existingBet.label = label;
    existingBet.stake = stake;
    existingBet.multiplier = Number(multiplier);
    existingBet.quantity = quantity == null ? null : Number(quantity);
    existingBet.updated_at = nowIso();

    state.transactions.push({
      id: state.nextTransactionId++,
      user_id: Number(userId),
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
    series_key: '',
    prop_key: propKey,
    prop_category: category,
    market_key: propKey,
    market_type: category,
    team_id: '',
    player_key: playerKey,
    player_name: playerName,
    player_team_id: String(playerTeamId || ''),
    quantity: quantity == null ? null : Number(quantity),
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
    propPlayerOverrides: { ...(state.oddsAdjustments.propPlayerOverrides[wk] || {}) }
  };
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
    state.oddsAdjustments.goalTotals[wk][cleanSeriesKey] = {
      line: cleanMultiplier(goalTotalLine, 'O/U line'),
      boost: cleanMultiplier(goalTotalBoost, 'O/U boost')
    };
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

    const payout = evaluation.won ? Math.round(Number(bet.stake || 0) * Number(bet.multiplier || 0)) : 0;
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
      const payout = evaluation.ready && evaluation.won ? Math.round(Number(b.stake || 0) * Number(b.multiplier || 0)) : 0;
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

  // Normal weekly flow: the new current week is being played, so lock it.
  // The new next week is now open for betting.
  setWeekLockedInternal(state.settings.currentWeek, true);
  setWeekLockedInternal(Number(state.settings.currentWeek) + 1, false);

  saveState();
  return getAdminSettings();
}

export function getAdminBetsForWeek(week) {
  const usersById = new Map(state.users.map(u => [u.id, u]));
  return state.bets
    .filter(b => Number(b.week) === Number(week) && b.status === 'open')
    .map(b => {
      const user = usersById.get(Number(b.user_id));
      return {
        ...b,
        user_display_name: user?.display_name || `User ${b.user_id}`,
        potential_return: Number(b.stake || 0) * Number(b.multiplier || 0)
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
  if (!Number.isFinite(value) || value === 0) throw new Error('Balance adjustment must be a non-zero number.');

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

  const startingBalance = Number(process.env.STARTING_BALANCE || 1000);
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
    const isTeamProp = bet.bet_kind === 'prop' && (teamSet.has(String(bet.player_team_id || '').trim()) || playerSet.has(String(bet.player_key || '').trim()));
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




const CASINO_SLOT_WAGERS = [10, 20, 30, 40, 50];
const CASINO_MAX_SLOT_WAGER = 50;
const CASINO_JACKPOT_CONTRIBUTION_RATE = 0.10;

const CASINO_SLOT_OUTCOMES = [
  { key: 'loss', label: 'Loss', weight: 56986, multiplier: 0, kind: 'loss' },
  { key: 'd3_pair', label: 'D3 Logo Pair', weight: 18000, multiplier: 1.0, tier: 'd3', matchCount: 2 },
  { key: 'd2_pair', label: 'D2 Logo Pair', weight: 9364, multiplier: 1.1, tier: 'd2', matchCount: 2 },
  { key: 'd1_pair', label: 'D1 Logo Pair', weight: 6800, multiplier: 1.5, tier: 'd1', matchCount: 2 },
  { key: 'wcpl_pair', label: 'WCPL Pair', weight: 2500, multiplier: 2.5, tier: 'wcpl', matchCount: 2 },
  { key: 'mushy_pair', label: 'Mushy Pair', weight: 1000, multiplier: 5, tier: 'mushy', matchCount: 2 },
  { key: 'd3_triple', label: 'D3 Logo Triple', weight: 3000, multiplier: 2, tier: 'd3', matchCount: 3 },
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
    { id: '206', label: '206', image: '/images/casino/D3/206.png', tier: 'd3' },
    { id: 'cgy', label: 'Calgary', image: '/images/casino/D3/CGY.png', tier: 'd3' },
    { id: 'evt', label: 'Everett', image: '/images/casino/D3/EVT.png', tier: 'd3' },
    { id: 'kln', label: 'Kelowna', image: '/images/casino/D3/KLN.png', tier: 'd3' },
    { id: 'van', label: 'Vancouver', image: '/images/casino/D3/VAN.png', tier: 'd3' },
    { id: 'vic', label: 'Victoria', image: '/images/casino/D3/VIC.png', tier: 'd3' }
  ],
  d1: [
    { id: 'bcl', label: 'BC Legless', image: '/images/casino/D1/BCL.png', tier: 'd1' },
    { id: 'll', label: 'Lot Lizards', image: '/images/casino/D1/LL.png', tier: 'd1' },
    { id: 'nk', label: 'Niagra Nicks', image: '/images/casino/D1/NK.png', tier: 'd1' },
    { id: 'pkn', label: 'Puckin Penguins', image: '/images/casino/D1/PKN.png', tier: 'd1' },
    { id: 'sea', label: 'Summer Seals', image: '/images/casino/D1/SEA.png', tier: 'd1' },
    { id: 'tor', label: 'Toronto Badgers', image: '/images/casino/D1/TOR.png', tier: 'd1' }
  ],
  d2: [
    { id: 'bck', label: 'Bucktown', image: '/images/casino/D2/BCK.png', tier: 'd2' },
    { id: 'bld', label: 'San Jose Blades', image: '/images/casino/D2/BLD.png', tier: 'd2' },
    { id: 'blm', label: 'Blooming Onions', image: '/images/casino/D2/BLM.png', tier: 'd2' },
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

export function getCasinoStateForUser(userId = null) {
  ensureCasinoState();

  const wageredByUser = new Map();
  for (const spin of state.casino.spins) {
    const uid = Number(spin.user_id);
    wageredByUser.set(uid, (wageredByUser.get(uid) || 0) + Number(spin.wager || 0));
  }

  const slotLeaderboard = [...wageredByUser.entries()]
    .map(([uid, totalWagered]) => {
      const user = state.users.find(u => Number(u.id) === Number(uid));
      return {
        user_id: uid,
        user_display_name: user?.display_name || `User ${uid}`,
        total_wagered: totalWagered
      };
    })
    .sort((a, b) => Number(b.total_wagered || 0) - Number(a.total_wagered || 0))
    .slice(0, 10);

  return {
    jackpotAmount: Math.floor(Number(state.casino.jackpotAmount || 0)),
    jackpotSeed: Math.floor(Number(state.casino.jackpotSeed || 0)),
    contributionRate: CASINO_JACKPOT_CONTRIBUTION_RATE,
    allowedWagers: [...CASINO_SLOT_WAGERS],
    slotLeaderboard,
    allSymbols: CASINO_ALL_SYMBOLS,
    balanceSummary: userId ? getBalanceSummaryForUser(userId) : null
  };
}

export function spinCasinoSlots({ userId, wager }) {
  ensureCasinoState();
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
