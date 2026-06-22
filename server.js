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
  cancelOpenBet,
  getUserPropBetsByCategory,
  placeOrUpdatePropBet,
  getAdminSettings,
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
  settleCompletedBets,
  voidBetById,
  voidBetsForSeries,
  voidDeprecatedHatTrickBetsForWeek,
  getVoidRefundsForWeek,
  getOpenBetCountForWeek,
  getUserSettledBetHistory,
  getOddsAdjustmentsForWeek,
  saveSeriesOddsForWeek,
  savePropDefaultOddsForWeek,
  savePropPlayerOverrideForWeek,
  clearPropPlayerOverrideForWeek,
  saveSeriesPropForWeek,
  saveSeriesPropsForWeek,
  createJsonBackup,
  getBackupInfo,
  getDatabasePath,
  getCasinoStateForUser,
  getCasinoSummary,
  setCasinoOpen,
  setCasinoLinkVisible,
  resetCasinoData,
  spinCasinoSlots,
  getShotDoctorStateForUser,
  startShotDoctorRun,
  submitShotDoctorGuess
} from './db.js';
import { getUpcomingSeries, buildMarketsForSeries, getPropBoards, getAvailableSeasons, getGoalTotalForSeries, getPlayers } from './services/wcplData.js';
import { buildShotDoctorRunShots } from './services/shotDoctor.js';
import { buildWeekSettlementResults, evaluateBetAgainstResults } from './services/settlement.js';
import { buildSeriesOddsRecommendations } from './services/oddsRecommendations.js';
import { buildWeeklyPropMarkets, propMarketsToBettingBoards } from './services/weeklyPropMarkets.js';
import { buildLeaderPropRecommendations } from './services/leaderPropRecommendations.js';

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
  res.locals.casinoOpen = adminSettings.casinoOpen;
  res.locals.casinoLinkVisible = adminSettings.casinoLinkVisible;
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

function getBettingView(req) {
  const settings = getAdminSettings();
  const currentWeek = Number(settings.currentWeek || 1);
  return { view: 'current', week: currentWeek, locked: isWeekLocked(currentWeek), openWeek: currentWeek };
}

async function filterLeaderPropPools(boards, { seasonId, week }) {
  const [reports, weekSeries] = await Promise.all([
    Promise.all(boards.map(board =>
      buildLeaderPropRecommendations({
        seasonId,
        divisionId: board.division_id,
        targetWeek: week
      })
    )),
    getUpcomingSeries(week, seasonId)
  ]);
  const byDivision = new Map(reports.map(report => [report.divisionId, report]));
  const opponentsByTeam = new Map();
  for (const series of weekSeries) {
    const awayKey = `${series.division_id}|${series.away_team_id}`;
    const homeKey = `${series.division_id}|${series.home_team_id}`;
    if (!opponentsByTeam.has(awayKey)) opponentsByTeam.set(awayKey, new Set());
    if (!opponentsByTeam.has(homeKey)) opponentsByTeam.set(homeKey, new Set());
    opponentsByTeam.get(awayKey).add(series.home_team_id);
    opponentsByTeam.get(homeKey).add(series.away_team_id);
  }

  return boards.map(board => {
    const report = byDivision.get(board.division_id);
    const scorerByKey = new Map((report?.topScorer || []).map(player => [player.playerKey, player]));
    const goalieByKey = new Map((report?.topGoalie || []).map(player => [player.playerKey, player]));
    const decoratePlayers = (players, recommendations) => players
      .filter(player => recommendations.has(player.player_key))
      .map(player => {
        const recommendation = recommendations.get(player.player_key);
        const opponents = [...(opponentsByTeam.get(
          `${board.division_id}|${player.team_id}`
        ) || [])];
        const opponentLabel = opponents.length > 1
          ? opponents.join(' and ')
          : (opponents[0] || 'TBD');
        const multiplier = Number(player.prop_multiplier || recommendation.recommendedOdds || 0);
        return {
          ...player,
          prop_multiplier: multiplier,
          option_label: `${player.display_name} - ${multiplier}x (vs ${opponentLabel})`,
          favorite_score: multiplier
        };
      })
      .sort((a, b) =>
        Number(a.favorite_score) - Number(b.favorite_score) ||
        String(a.display_name).localeCompare(String(b.display_name))
      );
    return {
      ...board,
      categories: board.categories.map(category => {
        if (category.category === 'top_scorer') {
          return {
            ...category,
            players: decoratePlayers(category.players, scorerByKey)
          };
        }
        if (category.category === 'top_goalie') {
          return {
            ...category,
            players: decoratePlayers(category.players, goalieByKey)
          };
        }
        return category;
      })
    };
  });
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
  const displayPercent = Math.round(percent * 100);

  if (percent === 0.5) {
    return { odds: '+100', percent: 50, title: '50% of Mushybux on this team.' };
  }

  const distanceFromEven = Math.abs(percent - 0.5) / 0.5;
  let odds = Math.round(100 + distanceFromEven * 900);

  if (percent > 0.5) odds = -odds;

  const displayOdds = odds > 0 ? `+${odds}` : String(odds);

  const intensity = Math.abs(displayPercent - 50) / 50;

return {
  odds: displayOdds,
  percent: displayPercent,
  title: `${displayPercent}% of Mushybux on this team.`,
  intensity,
  favorite: percent > 0.5,
  underdog: percent < 0.5
};
}

function groupSeriesByDivision(series, teamTotalMap, seriesResults = {}) {
  const groups = new Map();
  for (const s of series) {
    if (!groups.has(s.division_id)) {
      groups.set(s.division_id, { division_id: s.division_id, division_name: s.division_name, series: [] });
    }

    const awayTotal = teamTotalMap[s.away_team_id] || 0;
    const homeTotal = teamTotalMap[s.home_team_id] || 0;
    const result = seriesResults[s.series_key];
    const resultLabel = result?.complete
      ? `${result.winner_team_name} W ${result.winner_wins}-${result.loser_wins}`
      : '';
    const firstMatchId = String(s.games?.[0]?.match_id || '').trim();
    const resultBoxscoreUrl = result?.complete && firstMatchId
      ? `https://mushyfiles.ca/pages/boxscore.html?season=${encodeURIComponent(String(s.season_id || process.env.SEASON_ID || 'S3'))}&match_id=${encodeURIComponent(firstMatchId)}&division=${encodeURIComponent(String(s.division_id || ''))}`
      : '';

    groups.get(s.division_id).series.push({
      ...s,
      away_total: awayTotal,
      home_total: homeTotal,
      away_community_odds: formatCommunityOdds(awayTotal, homeTotal),
      home_community_odds: formatCommunityOdds(homeTotal, awayTotal),
      result_label: resultLabel,
      result_boxscore_url: resultBoxscoreUrl
    });
  }
  return [...groups.values()];
}


async function settleCompletedBetsOrThrow({ week, seasonId }) {
  const weekResults = await buildWeekSettlementResults({ seasonId, week });
  const preview = buildSettlementPreview({
    week,
    weekResults,
    evaluator: evaluateBetAgainstResults
  });

  const evaluations = Object.fromEntries(preview.rows.map(r => [r.id, {
    ready: r.ready,
    won: r.won,
    reason: r.evaluation_reason,
    result_summary: r.result_summary
  }]));

  return settleCompletedBets({ week, results: { evaluations } });
}

async function buildSeriesVoidPayload({ seasonId, week, seriesKey }) {
  const series = (await getUpcomingSeries(week, seasonId)).find(s => s.series_key === seriesKey);
  if (!series) throw new Error('Series not found for this week.');
  const teamIds = [series.home_team_id, series.away_team_id].map(v => String(v || '').trim());
  const players = await getPlayers(series.division_id, seasonId);
  const playerKeys = players
    .filter(p => teamIds.includes(String(p.team_id || '').trim()))
    .map(p => p.player_key);
  return { series, teamIds, playerKeys };
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
    const formatLeaderboard = rows => rows.map(u => ({
      ...u,
      last_week_display: formatSigned(u.last_week_change),
      current_week_display: formatSigned(u.current_week_change)
    }));
    const leaderboard = formatLeaderboard(getLeaderboard(currentWeek, false));
    const overallLeaderboard = formatLeaderboard(getLeaderboard(currentWeek, true));
    const series = await getUpcomingSeries(currentWeek, settings.seasonId);
    const teamTotals = applyTeamNamesToTotals(getWeeklyBetTotalByTeam(currentWeek), series);
    const teamTotalMap = getTeamTotalMap(teamTotals);
    const weekResults = await buildWeekSettlementResults({ seasonId: settings.seasonId, week: currentWeek });
    const matchupGroups = groupSeriesByDivision(series, teamTotalMap, weekResults.seriesResults);
function formatTopBetLabel(label) {
  const raw = String(label || '');

  const propMatch = raw.match(/^(Division \d+|League) (Top Scorer|Top Goalie|Hat Trick|Player Goals|Goalie Shutouts|Shutout): (.+)$/);
  if (propMatch) {
    const division = propMatch[1];
    const prop = propMatch[2];
    const pick = propMatch[3].replace(' · ', ' - ');

    if (['Hat Trick', 'Player Goals', 'Goalie Shutouts', 'Shutout'].includes(prop)) {
      return `${pick} (${division})`;
    }

    return `${pick} - ${prop} (${division})`;
  }

  return raw.split(': ').pop();
}
const topBets = getTopWeeklyBets(currentWeek, 8).map(b => ({
  ...b,
  label: formatTopBetLabel(b.label)
}));
    const currentUserBalance = req.session.userId ? getBalanceSummaryForUser(req.session.userId) : null;
    res.render('index', {
      leaderboard,
      overallLeaderboard,
      series,
      teamTotals,
      topBets,
      matchupGroups,
      currentUserBalance
    });
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

app.get('/casino', requireLogin, (req, res) => {
  const casinoState = getCasinoStateForUser(req.session.userId);
  const lastSpin = req.session.lastCasinoSpin || null;
  const lastWager = Number(req.session.lastCasinoWager || casinoState.allowedWagers[0] || 10);
  delete req.session.lastCasinoSpin;
  res.render('casino', { casinoState, lastSpin, lastWager });
});

app.post('/casino/slots/spin', requireLogin, (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const spin = spinCasinoSlots({
      userId: req.session.userId,
      wager: req.body.wager
    });
    req.session.lastCasinoSpin = spin;
    req.session.lastCasinoWager = spin.wager;

    if (wantsJson) {
      return res.json({ ok: true, spin, casinoState: getCasinoStateForUser(req.session.userId) });
    }

    return res.redirect('/casino');
  } catch (err) {
    if (wantsJson) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    req.session.flash = { type: 'error', message: err.message };
    return res.redirect('/casino');
  }
});


app.get('/casino/puckIQ', requireLogin, (req, res) => {
  const shotDoctorState = getShotDoctorStateForUser(req.session.userId);
  res.render('shot_doctor', { shotDoctorState });
});

app.post('/casino/puckIQ/start', requireLogin, async (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const shotDoctorState = getShotDoctorStateForUser(req.session.userId);
    const shots = await buildShotDoctorRunShots();
    const payload = startShotDoctorRun({
      userId: req.session.userId,
      wager: shotDoctorState.entryFee,
      shots
    });

    if (wantsJson) {
      return res.json({ ok: true, ...payload, shotDoctorState: getShotDoctorStateForUser(req.session.userId) });
    }
    return res.redirect('/casino/puckIQ');
  } catch (err) {
    if (wantsJson) return res.status(400).json({ ok: false, error: err.message });
    req.session.flash = { type: 'error', message: err.message };
    return res.redirect('/casino/puckIQ');
  }
});

app.post('/casino/puckIQ/guess', requireLogin, (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const payload = submitShotDoctorGuess({
      userId: req.session.userId,
      runId: req.body.run_id,
      guess: req.body.guess
    });

    if (wantsJson) {
      return res.json({ ok: true, ...payload, shotDoctorState: getShotDoctorStateForUser(req.session.userId) });
    }
    return res.redirect('/casino/puckIQ');
  } catch (err) {
    if (wantsJson) return res.status(400).json({ ok: false, error: err.message });
    req.session.flash = { type: 'error', message: err.message };
    return res.redirect('/casino/puckIQ');
  }
});

app.get('/casino/shot-doctor', requireLogin, (req, res) => res.redirect(301, '/casino/puckIQ'));
app.post('/casino/shot-doctor/start', requireLogin, (req, res) => res.redirect(307, '/casino/puckIQ/start'));
app.post('/casino/shot-doctor/guess', requireLogin, (req, res) => res.redirect(307, '/casino/puckIQ/guess'));

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
    const rawPropBoards = (await getPropBoards(bettingView.week, getAdminSettings().seasonId, activeOdds)).map(div => ({
      ...div,
      categories: div.categories.map(cat => ({
        ...cat,
        currentBet: propBetsByCategory[`${div.division_id}|${cat.category}`] || null
      }))
    }));
    const basePropBoards = await filterLeaderPropPools(rawPropBoards, {
      seasonId: getAdminSettings().seasonId,
      week: bettingView.week
    });
    const seriesPropMarkets = await buildWeeklyPropMarkets({
      seasonId: getAdminSettings().seasonId,
      week: bettingView.week,
      odds: activeOdds,
      publishedOnly: true
    });
    const propBoards = propMarketsToBettingBoards(
      seriesPropMarkets,
      basePropBoards,
      propBetsByCategory
    );

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
    const basePropBoards = await filterLeaderPropPools(
      await getPropBoards(bettingView.week, getAdminSettings().seasonId, activeOdds),
      {
        seasonId: getAdminSettings().seasonId,
        week: bettingView.week
      }
    );
    const seriesPropMarkets = await buildWeeklyPropMarkets({
      seasonId: getAdminSettings().seasonId,
      week: bettingView.week,
      odds: activeOdds,
      publishedOnly: true
    });
    const propBoards = propMarketsToBettingBoards(seriesPropMarkets, basePropBoards);
    const division = propBoards.find(d => d.division_id === divisionId);
    const prop = division?.categories.find(c => c.prop_key === propKey);
    if (!division || !prop) throw new Error('Prop not found.');

    const selectionKey = String(req.body.player_key || '');
    const player = prop.players.find(p =>
      String(p.selection_key || p.player_key) === selectionKey ||
      String(p.steam_id) === selectionKey
    );
    if (!player) throw new Error('Player not found for this prop.');

    let quantity = null;
    let propLine = null;
    let multiplier = Number(player.prop_multiplier || prop.multiplier || 0);
    let quantityLabel = '';
    if (prop.quantity_options?.length) {
      quantity = Number(req.body.quantity || 0);
      const selectedQuantity = prop.quantity_options.find(q => Number(q.quantity) === quantity);
      if (!selectedQuantity) throw new Error('Select a valid prop result.');
      multiplier = Number(player.prop_quantity_multipliers?.[String(quantity)] ?? selectedQuantity.multiplier);
      quantityLabel = player.prop_quantity_labels?.[String(quantity)] || selectedQuantity.label;
      propLine = player.prop_quantity_lines?.[String(quantity)] ?? null;
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
      marketKey: player.selection_key || propKey,
      playerKey: player.player_key,
      playerName: player.player_name || player.display_name,
      playerTeamId: player.team_id,
      seriesKey: player.series_key || '',
      propLine,
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
  res.redirect('/betting?type=props');
});

app.post('/bets/cancel', requireLogin, (req, res) => {
  const bettingView = getBettingView(req);
  const betType = String(req.body.type || 'series').toLowerCase() === 'props' ? 'props' : 'series';

  try {
    if (bettingView.locked) throw new Error('Betting is locked for this week.');

    const result = cancelOpenBet({
      userId: req.session.userId,
      betId: req.body.bet_id,
      locked: bettingView.locked
    });

    req.session.flash = {
      type: 'success',
      message: `Bet cancelled. ${result.refunded} Mushybux returned.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }

  res.redirect(`/betting?view=${bettingView.view}&type=${betType}`);
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
    const oddsWeekMode = String(req.query.odds_week || '') === 'current' ? 'current' : 'next';
    const oddsWeek = oddsWeekMode === 'current' ? currentWeek : nextWeek;
    const currentWeekBets = getAdminBetsForWeek(currentWeek);
    const nextWeekBets = getAdminBetsForWeek(nextWeek);
    const users = getUserSummaries();
    const seasons = await getAvailableSeasons();
    const reviewedOdds = getOddsAdjustmentsForWeek(oddsWeek);
    const currentWeekSeries = await getUpcomingSeries(currentWeek, settings.seasonId);
    const voidRefunds = getVoidRefundsForWeek(currentWeek);
    const backupInfo = getBackupInfo();
    const casinoSummary = getCasinoSummary();
    let settlementPreview = null;
    let seriesOddsRecommendations = null;
    let propOddsRecommendations = [];
    let leaderPropRecommendations = [];

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

    try {
      const recommendationReport = await buildSeriesOddsRecommendations({
        seasonId: settings.seasonId,
        targetWeek: oddsWeek
      });
      const reviewedSeries = await getUpcomingSeries(oddsWeek, settings.seasonId);
      const seriesByKey = new Map(reviewedSeries.map(series => [series.series_key, series]));

      seriesOddsRecommendations = {
        ...recommendationReport,
        recommendations: recommendationReport.recommendations.map(recommendation => {
          const series = seriesByKey.get(recommendation.seriesKey);
          const currentMarkets = series ? buildMarketsForSeries(series, reviewedOdds) : [];
          const currentByKey = Object.fromEntries(
            currentMarkets.map(market => [market.market_key, market.multiplier])
          );
          const marketKey = (type, teamId) =>
            `${recommendation.seriesKey}|${type}|${teamId}`;

          return {
            ...recommendation,
            hasSavedGoalLine: Boolean(reviewedOdds.goalTotals[recommendation.seriesKey]),
            currentGoalLine: series
              ? getGoalTotalForSeries(series, reviewedOdds).line
              : Number(process.env.GOAL_TOTAL_LINE || 10.5),
            awayCurrent: {
              hasSeriesWin: reviewedOdds.series[marketKey('series_win', recommendation.awayTeamId)] != null,
              hasExact21: reviewedOdds.series[marketKey('exact_2_1', recommendation.awayTeamId)] != null,
              hasSweep: reviewedOdds.series[marketKey('sweep_3_0', recommendation.awayTeamId)] != null,
              seriesWinOdds: Number(currentByKey[marketKey('series_win', recommendation.awayTeamId)] || 2),
              exact21Odds: Number(currentByKey[marketKey('exact_2_1', recommendation.awayTeamId)] || 3),
              sweepOdds: Number(currentByKey[marketKey('sweep_3_0', recommendation.awayTeamId)] || 4)
            },
            homeCurrent: {
              hasSeriesWin: reviewedOdds.series[marketKey('series_win', recommendation.homeTeamId)] != null,
              hasExact21: reviewedOdds.series[marketKey('exact_2_1', recommendation.homeTeamId)] != null,
              hasSweep: reviewedOdds.series[marketKey('sweep_3_0', recommendation.homeTeamId)] != null,
              seriesWinOdds: Number(currentByKey[marketKey('series_win', recommendation.homeTeamId)] || 2),
              exact21Odds: Number(currentByKey[marketKey('exact_2_1', recommendation.homeTeamId)] || 3),
              sweepOdds: Number(currentByKey[marketKey('sweep_3_0', recommendation.homeTeamId)] || 4)
            }
          };
        })
      };
    } catch (err) {
      seriesOddsRecommendations = { error: err.message, recommendations: [] };
    }

    try {
      propOddsRecommendations = await buildWeeklyPropMarkets({
        seasonId: settings.seasonId,
        week: oddsWeek,
        odds: reviewedOdds
      });
    } catch (err) {
      propOddsRecommendations = [{ error: err.message }];
    }

    try {
      const divisionIds = [...new Set(
        (await getUpcomingSeries(oddsWeek, settings.seasonId)).map(series => series.division_id)
      )];
      leaderPropRecommendations = await Promise.all(divisionIds.map(async divisionId => {
        const report = await buildLeaderPropRecommendations({
          seasonId: settings.seasonId,
          divisionId,
          targetWeek: oddsWeek
        });
        for (const category of ['topScorer', 'topGoalie']) {
          const storageCategory = category === 'topScorer' ? 'top_scorer' : 'top_goalie';
          report[category] = report[category].map(player => ({
            ...player,
            currentOdds: Number(
              reviewedOdds.propPlayerOverrides[
                `${divisionId}|${storageCategory}|${player.playerKey}`
              ] ?? player.recommendedOdds
            )
          }));
        }
        return report;
      }));
    } catch (err) {
      leaderPropRecommendations = [{ error: err.message }];
    }

    res.render('admin', {
      settings,
      currentWeek,
      nextWeek,
      oddsWeek,
      oddsWeekMode,
      openWeek: currentWeek,
      currentWeekBets,
      currentWeekSeries,
      voidRefunds,
      nextWeekBets,
      openWeekBets: nextWeekBets,
      users,
      seasons,
      settlementPreview,
      seriesOddsRecommendations,
      propOddsRecommendations,
      leaderPropRecommendations,
      backupInfo,
      casinoSummary
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

app.post('/admin/casino/open', requireAdmin, (req, res) => {
  const settings = setCasinoOpen(true);
  req.session.flash = { type: 'success', message: 'Casino opened. Users can wager again.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/close', requireAdmin, (req, res) => {
  const settings = setCasinoOpen(false);
  req.session.flash = { type: 'success', message: 'Casino closed. All casino wagering and gameplay is disabled.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/show-link', requireAdmin, (req, res) => {
  setCasinoLinkVisible(true);
  req.session.flash = { type: 'success', message: 'Casino navigation link is now visible.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/hide-link', requireAdmin, (req, res) => {
  setCasinoLinkVisible(false);
  req.session.flash = { type: 'success', message: 'Casino navigation link is now hidden.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/reset', requireAdmin, (req, res) => {
  try {
    const result = resetCasinoData();
    req.session.flash = {
      type: 'success',
      message: `Casino data reset. Restored ${result.usersRestored} user balance(s) and removed ${result.transactionsRemoved} casino ledger entries.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#casino-controls');
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


app.post('/admin/settle-completed', requireAdmin, async (req, res) => {
  try {
    const settings = getAdminSettings();
    const week = Number(req.body.week || settings.currentWeek);
    const result = await settleCompletedBetsOrThrow({ week, seasonId: settings.seasonId });
    req.session.flash = { type: 'success', message: `Settled completed Week ${week} bets: ${result.winners} winner(s), ${result.losers} loser(s), ${result.payoutTotal} Mushybux paid. ${result.skipped} bet(s) still unresolved.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/refund-bet', requireAdmin, (req, res) => {
  try {
    const result = voidBetById(req.body.bet_id, 'Manual admin refund');
    req.session.flash = { type: 'success', message: `Refunded ${result.refunded} Mushybux and voided ${result.count} bet.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/void-series', requireAdmin, async (req, res) => {
  try {
    const settings = getAdminSettings();
    const week = Number(req.body.week || settings.currentWeek);
    const seriesKey = String(req.body.series_key || '').trim();
    const payload = await buildSeriesVoidPayload({ seasonId: settings.seasonId, week, seriesKey });
    const result = voidBetsForSeries({
      week,
      seriesKey,
      teamIds: payload.teamIds,
      playerKeys: payload.playerKeys,
      reason: `Postponed series refund (${payload.series.away_team_name} at ${payload.series.home_team_name})`
    });
    req.session.flash = { type: 'success', message: `Voided postponed series bets: ${result.seriesCount} series bet(s), ${result.propCount} prop bet(s), ${result.refunded} Mushybux refunded.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/lock', requireAdmin, (req, res) => {
  const settings = getAdminSettings();
  setWeekLocked(settings.currentWeek, true);
  req.session.flash = { type: 'success', message: `Week ${settings.currentWeek} betting locked.` };
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
    const openCount = getOpenBetCountForWeek(before.currentWeek);
    if (openCount > 0) {
      throw new Error(`Week ${before.currentWeek} still has ${openCount} unsettled open bet(s). Settle completed bets, wait for incomplete results, or refund/void them before advancing.`);
    }
    const targetWeek = Number(before.currentWeek) + 1;
    const targetSeries = await getUpcomingSeries(targetWeek, before.seasonId);
    const targetOdds = getOddsAdjustmentsForWeek(targetWeek);
    const incompleteSeries = targetSeries.filter(series => {
      const expectedMarkets = buildMarketsForSeries(series, targetOdds);
      return expectedMarkets.some(market =>
        targetOdds.series[market.market_key] == null
      ) || targetOdds.goalTotals[series.series_key] == null;
    });
    if (incompleteSeries.length) {
      throw new Error(`Week ${targetWeek} lines are not ready. Apply or save odds for all ${incompleteSeries.length} remaining series before advancing.`);
    }
    if (!Object.keys(targetOdds.seriesProps || {}).length) {
      throw new Error(`Week ${targetWeek} player props are not ready. Apply the prop recommendations before advancing.`);
    }
    const divisions = [...new Set(targetSeries.map(series => series.division_id))];
    const missingLeaderMarkets = divisions.flatMap(divisionId =>
      ['top_scorer', 'top_goalie'].filter(category =>
        !Object.keys(targetOdds.propPlayerOverrides || {}).some(key =>
          key.startsWith(`${divisionId}|${category}|`)
        )
      ).map(category => `${divisionId} ${category.replace('_', ' ')}`)
    );
    if (missingLeaderMarkets.length) {
      throw new Error(`Week ${targetWeek} leader props are not ready: ${missingLeaderMarkets.join(', ')}.`);
    }

    const retiredProps = voidDeprecatedHatTrickBetsForWeek(targetWeek);
    const after = advanceWeek();
    const allowance = applyWeeklyAllowance(after.currentWeek);
    req.session.flash = {
      type: 'success',
      message: `Advanced to Week ${after.currentWeek}. Betting is open and ${allowance.amount} Mushybux allowance was applied to ${allowance.count} users.${retiredProps.count ? ` Voided ${retiredProps.count} retired hat-trick bet(s) and refunded ${retiredProps.refunded} Mushybux.` : ''}`
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
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
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
  res.redirect('/admin#series-odds-recommendations');
});

app.post('/admin/odds/bulk-series', requireAdmin, (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    const rows = JSON.parse(String(req.body.payload || '[]'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('No series odds were submitted.');
    for (const row of rows) {
      saveSeriesOddsForWeek({
        week: targetWeek,
        seriesKey: row.series_key,
        marketKeys: row.market_key || [],
        multipliers: row.multiplier || [],
        goalTotalLine: row.goal_total_line,
        goalTotalBoost: row.goal_total_boost
      });
    }
    req.session.flash = { type: 'success', message: `Applied all displayed Week ${targetWeek} series odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  const current = Number(req.body.week) === Number(getAdminSettings().currentWeek);
  res.redirect(`/admin?odds_week=${current ? 'current' : 'next'}#series-odds-recommendations`);
});

app.post('/admin/odds/apply-series-recommendations', requireAdmin, async (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    const report = await buildSeriesOddsRecommendations({
      seasonId: settings.seasonId,
      targetWeek
    });
    for (const rec of report.recommendations) {
      saveSeriesOddsForWeek({
        week: targetWeek,
        seriesKey: rec.seriesKey,
        marketKeys: [
          `${rec.seriesKey}|series_win|${rec.awayTeamId}`,
          `${rec.seriesKey}|exact_2_1|${rec.awayTeamId}`,
          `${rec.seriesKey}|sweep_3_0|${rec.awayTeamId}`,
          `${rec.seriesKey}|series_win|${rec.homeTeamId}`,
          `${rec.seriesKey}|exact_2_1|${rec.homeTeamId}`,
          `${rec.seriesKey}|sweep_3_0|${rec.homeTeamId}`
        ],
        multipliers: [
          rec.away.seriesWinOdds,
          rec.away.exact21Odds,
          rec.away.sweepOdds,
          rec.home.seriesWinOdds,
          rec.home.exact21Odds,
          rec.home.sweepOdds
        ],
        goalTotalLine: rec.recommendedGoalLine,
        goalTotalBoost: rec.goalTotalBoost
      });
    }
    req.session.flash = { type: 'success', message: `Applied all Week ${targetWeek} series recommendations.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#series-odds-recommendations');
});

app.post('/admin/odds/series-prop', requireAdmin, (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    saveSeriesPropForWeek({
      week: targetWeek,
      marketKey: req.body.market_key,
      config: {
        seriesKey: req.body.series_key,
        divisionId: req.body.division_id,
        category: req.body.category,
        playerKey: req.body.player_key,
        playerName: req.body.player_name,
        playerTeamId: req.body.player_team_id,
        opponentTeamId: req.body.opponent_team_id,
        eligibility: req.body.eligibility,
        enabled: String(req.body.enabled || '') === '1',
        tiers: [1, 2, 3].map(quantity => ({
          label: req.body[`label_${quantity}`],
          line: req.body[`line_${quantity}`],
          multiplier: req.body[`multiplier_${quantity}`]
        }))
      }
    });
    req.session.flash = { type: 'success', message: `Saved Week ${targetWeek} player prop.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(
    ['top_scorer', 'top_goalie'].includes(String(req.body.category || ''))
      ? '/admin#leader-prop-recommendations'
      : '/admin#prop-odds-recommendations'
  );
});

app.post('/admin/odds/apply-prop-recommendations', requireAdmin, async (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    const markets = await buildWeeklyPropMarkets({
      seasonId: settings.seasonId,
      week: targetWeek,
      odds: { seriesProps: {} }
    });
    saveSeriesPropsForWeek({
      week: targetWeek,
      markets: markets.map(market => ({
        ...market,
        enabled: market.eligibility === 'automatic'
      }))
    });
    req.session.flash = {
      type: 'success',
      message: `Applied Week ${targetWeek} prop recommendations. Review-only players remain disabled until you approve them.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#prop-odds-recommendations');
});

app.post('/admin/odds/apply-leader-prop-recommendations', requireAdmin, async (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    const divisionIds = [...new Set(
      (await getUpcomingSeries(targetWeek, settings.seasonId)).map(series => series.division_id)
    )];
    for (const divisionId of divisionIds) {
      const report = await buildLeaderPropRecommendations({
        seasonId: settings.seasonId,
        divisionId,
        targetWeek
      });
      for (const [category, players] of [
        ['top_scorer', report.topScorer],
        ['top_goalie', report.topGoalie]
      ]) {
        for (const player of players) {
          savePropPlayerOverrideForWeek({
            week: targetWeek,
            divisionId,
            category,
            playerKey: player.playerKey,
            multiplier: player.recommendedOdds
          });
        }
      }
    }
    req.session.flash = { type: 'success', message: `Applied Week ${targetWeek} Top Scorer and Top Goalie recommendations.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#leader-prop-recommendations');
});

app.post('/admin/odds/bulk-leader-props', requireAdmin, (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    const rows = JSON.parse(String(req.body.payload || '[]'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('No leader prop odds were submitted.');
    for (const row of rows) {
      savePropPlayerOverrideForWeek({
        week: targetWeek,
        divisionId: row.division_id,
        category: row.category,
        playerKey: row.player_key,
        multiplier: row.multiplier
      });
    }
    req.session.flash = { type: 'success', message: `Applied all displayed Week ${targetWeek} Top Scorer and Top Goalie odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  const current = Number(req.body.week) === Number(getAdminSettings().currentWeek);
  res.redirect(`/admin?odds_week=${current ? 'current' : 'next'}#leader-prop-recommendations`);
});

app.post('/admin/odds/bulk-player-props', requireAdmin, (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    const rows = JSON.parse(String(req.body.payload || '[]'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('No player props were submitted.');
    saveSeriesPropsForWeek({
      week: targetWeek,
      markets: rows.map(row => ({
        marketKey: row.market_key,
        seriesKey: row.series_key,
        divisionId: row.division_id,
        category: row.category,
        playerKey: row.player_key,
        playerName: row.player_name,
        playerTeamId: row.player_team_id,
        opponentTeamId: row.opponent_team_id,
        eligibility: row.eligibility,
        enabled: Boolean(row.enabled),
        tiers: row.tiers
      }))
    });
    req.session.flash = { type: 'success', message: `Applied all displayed Week ${targetWeek} player props.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  const current = Number(req.body.week) === Number(getAdminSettings().currentWeek);
  res.redirect(`/admin?odds_week=${current ? 'current' : 'next'}#prop-odds-recommendations`);
});

app.post('/admin/odds/prop-default', requireAdmin, (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
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
  res.redirect('/admin#prop-odds-recommendations');
});

app.post('/admin/odds/player-override', requireAdmin, (req, res) => {
  try {
    const settings = getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
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
  res.redirect(
    ['top_scorer', 'top_goalie'].includes(String(req.body.category || ''))
      ? '/admin#leader-prop-recommendations'
      : '/admin#prop-odds-recommendations'
  );
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`<h1>Something broke</h1><pre>${err.message}</pre>`);
});

app.listen(port, () => {
  console.log(`WCPL Betting running at http://localhost:${port}`);
});
