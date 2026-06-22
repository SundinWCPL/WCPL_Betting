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
      seasonId: process.env.SEASON_ID || 'S3',
      casinoOpen: true,
      casinoLinkVisible: false
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
      shotDoctorRuns: []
    },
    nextUserId: 1,
    nextBetId: 1,
    nextTransactionId: 1,
    nextCasinoSpinId: 1,
    nextShotDoctorRunId: 1
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
    ...(state.settings || {})
  };
  state.settings.currentWeek = Number(state.settings.currentWeek || 1);
  state.settings.weeklyAllowance = Number(state.settings.weeklyAllowance || 100);
  state.settings.seasonId = String(state.settings.seasonId || process.env.SEASON_ID || 'S3');
  state.settings.casinoOpen = state.settings.casinoOpen !== false;
  state.settings.casinoLinkVisible = state.settings.casinoLinkVisible === true;

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
  state.nextCasinoSpinId = Number(state.nextCasinoSpinId || 1);
  state.nextShotDoctorRunId = Number(state.nextShotDoctorRunId || 1);
}

function normalizeWholeMushybux() {
  for (const user of state.users || []) {
    user.balance = Math.ceil(Number(user.balance || 0));
  }
  for (const bet of state.bets || []) {
    bet.stake = Math.ceil(Number(bet.stake || 0));
    if (bet.payout != null) bet.payout = Math.ceil(Number(bet.payout || 0));
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
      const overallBalance = Number(user.balance || 0) + openWagered;
      const totalBalance = includeCasino ? overallBalance : overallBalance - casinoNet;
      const lastWeekBettingChange = getSettledBetNetForUser(user.id, weekNum - 1);
      const currentWeekBettingChange = getSettledBetNetForUser(user.id, weekNum);
      return {
        id: user.id,
        display_name: user.display_name,
        username: user.username,
        balance: user.balance,
        open_wagered: openWagered,
        casino_net: casinoNet,
        total_balance: totalBalance,
        balance_display: formatBalanceDisplay(totalBalance, openWagered),
        last_week_change: lastWeekBettingChange + (
          includeCasino ? getCasinoNetForUserWeek(user.id, weekNum - 1) : 0
        ),
        current_week_change: currentWeekBettingChange + (
          includeCasino ? getCasinoNetForUserWeek(user.id, weekNum) : 0
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

export function getAdminBetsForWeek(week) {
  const usersById = new Map(state.users.map(u => [u.id, u]));
  return state.bets
    .filter(b => Number(b.week) === Number(week) && b.status === 'open')
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
  const totalWagered = slotWagered + puckIqWagered;
  const totalPaid = slotPaid + puckIqPaid;

  return {
    totalWagered,
    totalPaid,
    netProfit: totalPaid - totalWagered,
    slotSpins: state.casino.spins.length,
    puckIqRuns: state.casino.shotDoctorRuns.length
  };
}

export function resetCasinoData() {
  ensureCasinoState();
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
    shotDoctorRuns: []
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

  return {
    isOpen: getAdminSettings().casinoOpen,
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
