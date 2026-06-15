import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  initDb,
  authenticate,
  getUserById,
  getLeaderboard,
  getUserBetsBySeries,
  getWeeklyBetTotalByTeam,
  getTopWeeklyBets,
  getBalanceSummaryForUser,
  placeOrUpdateBet,
  getUserPropBetsByCategory,
  placeOrUpdatePropBet,
  getAdminSettings,
  setBettingLocked,
  setWeekLocked,
  isWeekLocked,
  setWeeklyAllowance,
  applyWeeklyAllowance,
  advanceWeek,
  getAdminBetsForWeek,
  getUserSummaries,
  resetBetsForWeek,
  resetAllData,
  adjustUserBalance,
  addUser,
  updateUserDetails,
  setSeasonId,
  buildSettlementPreview,
  settleWeek,
  getUserSettledBetHistory,
  getOddsAdjustmentsForWeek,
  saveSeriesOddsForWeek,
  savePropDefaultOddsForWeek,
  savePropPlayerOverrideForWeek,
  clearPropPlayerOverrideForWeek,
  createJsonBackup,
  getBackupInfo,
  getDatabasePath
} from './db.js';
import { getUpcomingSeries, buildMarketsForSeries, getPropBoards, getAvailableSeasons, getGoalTotalForSeries } from './services/wcplData.js';
import { buildWeekSettlementResults, evaluateBetAgainstResults } from './services/settlement.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
initDb();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.userId ? getUserById(req.session.userId) : null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  const adminSettings = getAdminSettings();
  res.locals.currentWeek = adminSettings.currentWeek;
  res.locals.bettingLocked = adminSettings.currentWeekLocked;
  res.locals.weeklyAllowance = adminSettings.weeklyAllowance;
  res.locals.seasonId = adminSettings.seasonId;
  res.locals.maxBet = Number(process.env.MAX_BET || 250);
  res.locals.propMaxBet = Number(process.env.PROP_MAX_BET || 100);
  res.locals.goalTotalLine = Number(process.env.GOAL_TOTAL_LINE || 10.5);
  res.locals.goalTotalBoost = Number(process.env.GOAL_TOTAL_BOOST || 1.5);
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    req.session.flash = { type: 'error', message: 'Please log in first.' };
    return res.redirect('/login');
  }
  next();
}

function getOpenBettingWeek(settings = getAdminSettings()) {
  // "Next week" is always the main open betting week. Week 1 is special:
  // both Week 1 and Week 2 can be open until the commissioner locks Week 1.
  return Number(settings.currentWeek || 1) + 1;
}

function getBettingView(req) {
  const settings = getAdminSettings();
  const currentWeek = Number(settings.currentWeek || 1);
  const requested = String(req.query.view || req.body.view || 'current').toLowerCase();
  const view = requested === 'next' ? 'next' : 'current';
  const week = view === 'next' ? currentWeek + 1 : currentWeek;
  const locked = isWeekLocked(week);
  return { view, week, locked, openWeek: currentWeek + 1 };
}

function formatSigned(n) {
  const value = Number(n || 0);
  return value > 0 ? `+${value}` : String(value);
}

function getTeamNameMap(series) {
  const teamNames = new Map();
  for (const s of series) {
    teamNames.set(s.home_team_id, s.home_team_name);
    teamNames.set(s.away_team_id, s.away_team_name);
  }
  return teamNames;
}

function applyTeamNamesToTotals(teamTotals, series) {
  const teamNames = getTeamNameMap(series);
  return teamTotals.map(t => ({
    ...t,
    team_name: teamNames.get(t.team_id) || t.team_id
  }));
}

function getTeamTotalMap(teamTotals) {
  return Object.fromEntries(teamTotals.map(t => [t.team_id, Number(t.total_stake || 0)]));
}

function formatCommunityOdds(teamStake, opponentStake) {
  const total = Number(teamStake || 0) + Number(opponentStake || 0);

  if (total <= 0) {
    return { odds: '+100', percent: 0, title: 'No Mushybux placed on this matchup yet.' };
  }

  const percent = Number(teamStake || 0) / total;

  if (percent === 0.5) {
    return { odds: '+100', percent: 50, title: '50% of Mushybux on this team.' };
  }

  let odds;
  if (percent > 0.5) {
    odds = -Math.round(100 * percent / (1 - percent || 0.01));
    odds = Math.max(odds, -1000);
  } else {
    odds = Math.round(100 * (1 - percent) / (percent || 0.01));
    odds = Math.min(odds, 1000);
  }

  const displayOdds = odds > 0 ? `+${odds}` : String(odds);
  const displayPercent = Math.round(percent * 100);

  return {
    odds: displayOdds,
    percent: displayPercent,
    title: `${displayPercent}% of Mushybux on this team.`
  };
}

function groupSeriesByDivision(series, teamTotalMap) {
  const groups = new Map();
  for (const s of series) {
    if (!groups.has(s.division_id)) {
      groups.set(s.division_id, { division_id: s.division_id, division_name: s.division_name, series: [] });
    }

    const awayTotal = teamTotalMap[s.away_team_id] || 0;
    const homeTotal = teamTotalMap[s.home_team_id] || 0;

    groups.get(s.division_id).series.push({
      ...s,
      away_total: awayTotal,
      home_total: homeTotal,
      away_community_odds: formatCommunityOdds(awayTotal, homeTotal),
      home_community_odds: formatCommunityOdds(homeTotal, awayTotal)
    });
  }
  return [...groups.values()];
}

async function settleWeekOrThrow({ week, seasonId }) {
  const weekResults = await buildWeekSettlementResults({ seasonId, week });
  const preview = buildSettlementPreview({
    week,
    weekResults,
    evaluator: evaluateBetAgainstResults
  });

  if (!preview.ready) {
    throw new Error(`Week ${week} cannot be settled yet. ${preview.skipped} bet(s) have incomplete results.`);
  }

  const evaluations = Object.fromEntries(preview.rows.map(r => [r.id, {
    ready: r.ready,
    won: r.won,
    reason: r.evaluation_reason,
    result_summary: r.result_summary
  }]));

  return settleWeek({ week, results: { evaluations } });
}

app.get('/', async (req, res, next) => {
  try {
    const settings = getAdminSettings();
    const currentWeek = Number(settings.currentWeek || 1);
    const leaderboard = getLeaderboard().map(u => ({ ...u, last_week_display: formatSigned(u.last_week_change) }));
    const series = await getUpcomingSeries(currentWeek, settings.seasonId);
    const teamTotals = applyTeamNamesToTotals(getWeeklyBetTotalByTeam(currentWeek), series);
    const teamTotalMap = getTeamTotalMap(teamTotals);
    const matchupGroups = groupSeriesByDivision(series, teamTotalMap);
    const topBets = getTopWeeklyBets(currentWeek, 5).map(b => ({
      ...b,
      label: String(b.label || '').split(': ').pop()
    }));
    const currentUserBalance = req.session.userId ? getBalanceSummaryForUser(req.session.userId) : null;
    res.render('index', { leaderboard, series, teamTotals, topBets, matchupGroups, currentUserBalance });
  } catch (err) {
    next(err);
  }
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  const user = authenticate(req.body.username || '', req.body.password || '');
  if (!user) {
    req.session.flash = { type: 'error', message: 'Invalid username or password.' };
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  req.session.flash = { type: 'success', message: `Welcome back, ${user.display_name}.` };
  res.redirect('/betting');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/history', requireLogin, (req, res) => {
  const history = getUserSettledBetHistory(req.session.userId);
  res.render('history', { history });
});

app.get('/betting', requireLogin, async (req, res, next) => {
  try {
    const bettingView = getBettingView(req);
    const betType = String(req.query.type || 'series').toLowerCase() === 'props' ? 'props' : 'series';
    const activeOdds = getOddsAdjustmentsForWeek(bettingView.week);
    const series = await getUpcomingSeries(bettingView.week, getAdminSettings().seasonId);
    const betsBySeries = getUserBetsBySeries(req.session.userId, bettingView.week);
    const board = series.map(s => ({
      ...s,
      markets: buildMarketsForSeries(s, activeOdds),
      goalTotal: getGoalTotalForSeries(s, activeOdds),
      currentBet: betsBySeries[s.series_key] || null
    }));

    const propBetsByCategory = getUserPropBetsByCategory(req.session.userId, bettingView.week);
    const propBoards = (await getPropBoards(bettingView.week, getAdminSettings().seasonId, activeOdds)).map(div => ({
      ...div,
      categories: div.categories.map(cat => ({
        ...cat,
        currentBet: propBetsByCategory[`${div.division_id}|${cat.category}`] || null
      }))
    }));

    const balanceSummary = getBalanceSummaryForUser(req.session.userId);
    res.render('betting', { board, propBoards, bettingView, betType, balanceSummary });
  } catch (err) {
    next(err);
  }
});

app.post('/bets', requireLogin, async (req, res) => {
  const bettingView = getBettingView(req);
  try {
    if (bettingView.locked) throw new Error('Betting is locked for this week.');

    const stake = Number(req.body.stake);
    const activeOdds = getOddsAdjustmentsForWeek(bettingView.week);
    const series = (await getUpcomingSeries(bettingView.week, getAdminSettings().seasonId)).find(s => s.series_key === req.body.series_key);
    if (!series) throw new Error('Series not found.');

    const market = buildMarketsForSeries(series, activeOdds).find(m => m.market_key === req.body.market_key);
    if (!market) throw new Error('Market not found.');

    const goalTotalSideRaw = String(req.body.goal_total_side || '').toLowerCase();
    const goalTotalSide = ['over', 'under'].includes(goalTotalSideRaw) ? goalTotalSideRaw : '';
    const seriesGoalTotal = getGoalTotalForSeries(series, activeOdds);
    const goalTotalLine = Number(req.body.goal_total_line || seriesGoalTotal.line || 10.5);
    const goalTotalBoost = Number(seriesGoalTotal.boost || process.env.GOAL_TOTAL_BOOST || 1.5);
    const multiplier = goalTotalSide ? Number((Number(market.multiplier) * goalTotalBoost).toFixed(2)) : Number(market.multiplier);
    const goalTotalLabel = goalTotalSide ? ` + ${goalTotalSide === 'over' ? 'Over' : 'Under'} ${goalTotalLine}` : '';

    const result = placeOrUpdateBet({
      userId: req.session.userId,
      week: bettingView.week,
      divisionId: series.division_id,
      seriesKey: series.series_key,
      marketKey: market.market_key,
      marketType: market.type,
      teamId: market.team_id,
      label: `${series.away_team_name} at ${series.home_team_name}: ${market.label}${goalTotalLabel}`,
      stake,
      multiplier,
      goalTotalSide,
      goalTotalLine: goalTotalSide ? goalTotalLine : null,
      goalTotalBoost: goalTotalSide ? goalTotalBoost : null,
      locked: bettingView.locked
    });

    req.session.flash = {
      type: 'success',
      message: result.action === 'updated' ? 'Bet updated.' : 'Bet placed.'
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/betting?view=${bettingView.view}&type=series`);
});

app.post('/prop-bets', requireLogin, async (req, res) => {
  const bettingView = getBettingView(req);
  try {
    if (bettingView.locked) throw new Error('Betting is locked for this week.');

    const propKey = String(req.body.prop_key || '');
    const [divisionId, category] = propKey.split('|');
    if (!divisionId || !category) throw new Error('Prop not found.');

    const activeOdds = getOddsAdjustmentsForWeek(bettingView.week);
    const propBoards = await getPropBoards(bettingView.week, getAdminSettings().seasonId, activeOdds);
    const division = propBoards.find(d => d.division_id === divisionId);
    const prop = division?.categories.find(c => c.category === category);
    if (!division || !prop) throw new Error('Prop not found.');

    const playerKey = String(req.body.player_key || '');
    const player = prop.players.find(p => String(p.player_key) === playerKey || String(p.steam_id) === playerKey);
    if (!player) throw new Error('Player not found for this prop.');

    let quantity = null;
    let multiplier = Number(player.prop_multiplier || prop.multiplier || 0);
    let quantityLabel = '';
    if (prop.quantity_options?.length) {
      quantity = Number(req.body.quantity || 0);
      const selectedQuantity = prop.quantity_options.find(q => Number(q.quantity) === quantity);
      if (!selectedQuantity) throw new Error('Select a valid prop result.');
      multiplier = Number(player.prop_quantity_multipliers?.[String(quantity)] ?? selectedQuantity.multiplier);
      quantityLabel = selectedQuantity.label;
    }

    const label = quantityLabel
      ? `${division.division_name} ${prop.title}: ${player.display_name} · ${quantityLabel}`
      : `${division.division_name} ${prop.title}: ${player.display_name}`;

    const result = placeOrUpdatePropBet({
      userId: req.session.userId,
      week: bettingView.week,
      divisionId,
      propKey,
      category,
      playerKey: player.player_key,
      playerName: player.display_name,
      label,
      stake: Number(req.body.stake),
      multiplier,
      quantity,
      locked: bettingView.locked
    });

    req.session.flash = {
      type: 'success',
      message: result.action === 'updated' ? 'Prop bet updated.' : 'Prop bet placed.'
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/betting?view=${bettingView.view}&type=props`);
});

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    req.session.flash = { type: 'error', message: 'Please log in first.' };
    return res.redirect('/login');
  }
  const user = getUserById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).send('Admin only.');
  next();
}

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const settings = getAdminSettings();
    const currentWeek = Number(settings.currentWeek || 1);
    const nextWeek = currentWeek + 1;
    const followingWeek = nextWeek + 1;
    const currentWeekBets = getAdminBetsForWeek(currentWeek);
    const nextWeekBets = getAdminBetsForWeek(nextWeek);
    const users = getUserSummaries();
    const seasons = await getAvailableSeasons();
    const followingWeekOdds = getOddsAdjustmentsForWeek(followingWeek);
    const followingWeekSeries = await getUpcomingSeries(followingWeek, settings.seasonId);
    const followingWeekSeriesBoard = followingWeekSeries.map(s => ({
      ...s,
      markets: buildMarketsForSeries(s, followingWeekOdds),
      goalTotal: getGoalTotalForSeries(s, followingWeekOdds)
    }));
    const followingWeekPropBoards = await getPropBoards(followingWeek, settings.seasonId, followingWeekOdds);
    const backupInfo = getBackupInfo();
    let settlementPreview = null;

    try {
      const weekResults = await buildWeekSettlementResults({ seasonId: settings.seasonId, week: currentWeek });
      settlementPreview = buildSettlementPreview({
        week: currentWeek,
        weekResults,
        evaluator: evaluateBetAgainstResults
      });
    } catch (err) {
      settlementPreview = { error: err.message };
    }

    res.render('admin', {
      settings,
      currentWeek,
      nextWeek,
      openWeek: nextWeek,
      followingWeek,
      currentWeekBets,
      nextWeekBets,
      openWeekBets: nextWeekBets,
      users,
      seasons,
      settlementPreview,
      followingWeekOdds,
      followingWeekSeriesBoard,
      followingWeekPropBoards,
      backupInfo
    });
  } catch (err) {
    next(err);
  }
});



app.post('/admin/backup/create', requireAdmin, (req, res) => {
  try {
    const backup = createJsonBackup();
    req.session.flash = { type: 'success', message: `Created backup: ${backup.filename}` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.get('/admin/backup/download', requireAdmin, (req, res) => {
  const filePath = getDatabasePath();
  if (!fs.existsSync(filePath)) {
    req.session.flash = { type: 'error', message: 'No betting database exists yet.' };
    return res.redirect('/admin');
  }
  const settings = getAdminSettings();
  const filename = `wcpl-betting-week-${settings.currentWeek}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  res.download(filePath, filename);
});

app.post('/admin/season', requireAdmin, (req, res) => {
  try {
    const settings = setSeasonId(req.body.season_id);
    req.session.flash = { type: 'success', message: `Switched debug season to ${settings.seasonId}. Week reset to 1.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/settle-week', requireAdmin, async (req, res) => {
  try {
    const settings = getAdminSettings();
    const week = Number(req.body.week || settings.currentWeek);
    const result = await settleWeekOrThrow({ week, seasonId: settings.seasonId });
    req.session.flash = { type: 'success', message: `Settled Week ${week}: ${result.winners} winner(s), ${result.losers} loser(s), ${result.payoutTotal} Mushybux paid.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/lock', requireAdmin, (req, res) => {
  const settings = getAdminSettings();
  setWeekLocked(settings.currentWeek, true);
  req.session.flash = { type: 'success', message: `Week ${settings.currentWeek} betting locked. Next week remains open.` };
  res.redirect('/admin');
});

app.post('/admin/unlock', requireAdmin, (req, res) => {
  const settings = getAdminSettings();
  setWeekLocked(settings.currentWeek, false);
  req.session.flash = { type: 'success', message: `Week ${settings.currentWeek} betting unlocked.` };
  res.redirect('/admin');
});

app.post('/admin/allowance', requireAdmin, (req, res) => {
  try {
    setWeeklyAllowance(req.body.weekly_allowance);
    req.session.flash = { type: 'success', message: 'Weekly allowance updated.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/apply-allowance', requireAdmin, (req, res) => {
  try {
    const settings = getAdminSettings();
    const result = applyWeeklyAllowance(settings.currentWeek);
    req.session.flash = { type: 'success', message: `Applied ${result.amount} Mushybux allowance to ${result.count} users.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/reset-week-bets', requireAdmin, (req, res) => {
  try {
    const week = Number(req.body.week);
    const result = resetBetsForWeek(week);
    req.session.flash = { type: 'success', message: `Voided ${result.count} Week ${week} bets and refunded ${result.refunded} Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

// Backwards-compatible route from earlier admin page versions.
app.post('/admin/reset-open-bets', requireAdmin, (req, res) => {
  try {
    const settings = getAdminSettings();
    const nextWeek = Number(settings.currentWeek || 1) + 1;
    const result = resetBetsForWeek(nextWeek);
    req.session.flash = { type: 'success', message: `Voided ${result.count} Week ${nextWeek} bets and refunded ${result.refunded} Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/reset-all-data', requireAdmin, (req, res) => {
  resetAllData();
  req.session.flash = { type: 'success', message: 'All test data reset.' };
  res.redirect('/admin');
});

app.post('/admin/advance-week', requireAdmin, async (req, res) => {
  try {
    const before = getAdminSettings();
    const settlement = await settleWeekOrThrow({ week: before.currentWeek, seasonId: before.seasonId });
    const after = advanceWeek();
    const allowance = applyWeeklyAllowance(after.currentWeek);
    req.session.flash = {
      type: 'success',
      message: `Settled Week ${before.currentWeek}: ${settlement.winners} winner(s), ${settlement.losers} loser(s), ${settlement.payoutTotal} Mushybux paid. Advanced to Week ${after.currentWeek}. Week ${after.currentWeek} is locked, Week ${Number(after.currentWeek) + 1} is open, and ${allowance.amount} Mushybux allowance was applied to ${allowance.count} users.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/adjust-balance', requireAdmin, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const note = String(req.body.note || '').trim();
    adjustUserBalance(req.body.user_id, amount, note);
    req.session.flash = { type: 'success', message: `Balance adjusted by ${amount} Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/add-user', requireAdmin, (req, res) => {
  try {
    const user = addUser({
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.display_name,
      role: req.body.role
    });
    req.session.flash = { type: 'success', message: `Added ${user.display_name} with starting Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/update-user', requireAdmin, (req, res) => {
  try {
    const user = updateUserDetails({
      userId: req.body.user_id,
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.display_name,
      role: req.body.role
    });
    req.session.flash = { type: 'success', message: `Updated ${user.display_name}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});



app.post('/admin/odds/series', requireAdmin, (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 2);
    saveSeriesOddsForWeek({
      week: targetWeek,
      seriesKey: req.body.series_key,
      marketKeys: req.body.market_key || [],
      multipliers: req.body.multiplier || [],
      goalTotalLine: req.body.goal_total_line,
      goalTotalBoost: req.body.goal_total_boost
    });
    req.session.flash = { type: 'success', message: `Saved Week ${targetWeek} series odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#following-week-odds');
});

app.post('/admin/odds/prop-default', requireAdmin, (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 2);
    savePropDefaultOddsForWeek({
      week: targetWeek,
      divisionId: req.body.division_id,
      category: req.body.category,
      multiplier: req.body.multiplier,
      quantity1: req.body.quantity_1,
      quantity2: req.body.quantity_2,
      quantity3: req.body.quantity_3
    });
    req.session.flash = { type: 'success', message: `Saved Week ${targetWeek} prop odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#following-week-odds');
});

app.post('/admin/odds/player-override', requireAdmin, (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 2);
    if (String(req.body.clear || '') === '1') {
      clearPropPlayerOverrideForWeek({
        week: targetWeek,
        divisionId: req.body.division_id,
        category: req.body.category,
        playerKey: req.body.player_key
      });
      req.session.flash = { type: 'success', message: `Cleared Week ${targetWeek} player odds override.` };
    } else {
      const category = String(req.body.category || '');
      if (category === 'hat_trick' || category === 'shutout') {
        for (const q of [1, 2, 3]) {
          const value = req.body[`quantity_${q}`];
          if (String(value ?? '').trim()) {
            savePropPlayerOverrideForWeek({
              week: targetWeek,
              divisionId: req.body.division_id,
              category,
              playerKey: req.body.player_key,
              multiplier: value,
              quantity: q
            });
          }
        }
      } else {
        savePropPlayerOverrideForWeek({
          week: targetWeek,
          divisionId: req.body.division_id,
          category,
          playerKey: req.body.player_key,
          multiplier: req.body.multiplier
        });
      }
      req.session.flash = { type: 'success', message: `Saved Week ${targetWeek} player odds override.` };
    }
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#following-week-odds');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`<h1>Something broke</h1><pre>${err.message}</pre>`);
});

app.listen(port, () => {
  console.log(`WCPL Betting running at http://localhost:${port}`);
});
