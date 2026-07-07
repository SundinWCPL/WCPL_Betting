import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  initDb,
  initDbFromPostgresSnapshot,
  authenticate,
  getUserById,
  getUserBets,
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
  getAdminSettledBets,
  getUserSummaries,
  resetBetsForWeek,
  resetAllData,
  adjustUserBalance,
  adjustAllUserBalances,
  addUser,
  updateUserDetails,
  setSeasonId,
  buildSettlementPreview,
  settleWeek,
  settleCompletedBets,
  correctSettledBet,
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
  setMaintenanceMode,
  setCasinoLinkVisible,
  resetCasinoData,
  spinCasinoSlots,
  getHorseRaceStateForUser,
  placeOrUpdateHorseRaceBet,
  buyHorse,
  claimHorseOwnerWinnings,
  saveHorseRacingConfig,
  processCurrentHorseRace,
  getHorseRaceChatState,
  addHorseRaceChatMessage,
  controlCurrentHorseRace,
  getShotDoctorStateForUser,
  startShotDoctorRun,
  submitShotDoctorGuess,
  getCardsConfig,
  getCardsAdminState,
  saveCardsConfig,
  setWutFreeShopPurchases,
  setCardsOpen,
  setCardsLinkVisible,
  setCardsAllowRetroactiveAssignment,
  setCardsPositionOverride,
  setCardsTierOverride,
  setCardsPlayerOverrides,
  saveCalculatedCardTiers,
  getCardsOwnedState,
  getCardsLineup,
  getAllCardsLineupsForWeek,
  setCardsLineupSlot,
  resolveCardsLineupResult,
  createCardsPackPurchase,
  getPendingCardsPack,
  claimCardsPack,
  getWutMembershipState,
  joinWut,
  openWutStarterPack,
  adjustWutCoinBalance,
  grantCardsTestItem,
  getCardsWeekReviews,
  acknowledgeCardsWeekReview,
  finalizeCardsWeek,
  getCardsLeaderboard,
  resetCardsData,
  getArenaStateForUser,
  getArenaAdminState,
  getArenaAdminMatchState,
  hasPendingArenaTurn,
  getPendingWutDraftActionEventIds,
  recalculateArenaEloFromHistory,
  adminVoidArenaMatch,
  enterArenaQueue,
  assignArenaMatchups,
  commitArenaTurn,
  autoAssignExpiredArenaTurns,
  getArenaMatchesNeedingScoring,
  completeArenaMatch,
  completeArenaReveal,
  claimArenaWinnings,
  claimWutMission,
  getWutSystemsState,
  setWutMissionBetOpportunities,
  saveWutDeck,
  buyWutDeckSlot,
  buyWutTrinket,
  rerollWutTrinketShop,
  attachWutTrinket,
  removeWutTrinket,
  reconcileWutTrinketPositions,
  calculateWutPower,
  getWutDebugMatch,
  queueWutDebugRescore,
  resetWutDebugMatch,
  commitWutDebugPlacement,
  getWutDraftEventPresets,
  getWutDraftEventLobby,
  createWutDraftEvent,
  saveWutDraftEventPreset,
  transitionWutDraftEvent,
  pauseWutDraftEvent,
  resumeWutDraftEvent,
  joinWutDraftEvent,
  withdrawWutDraftEvent,
  dropWutDraftEventEntrant,
  startWutDraftEvent,
  resolveWutDraftEventMatch,
  resetCurrentWutDraftEventRound,
  beginWutDraftSafetyBench,
  voteWutDraftSafetyBench,
  finishWutDraftSafetyBench,
  extendWutDraftSafetyBench,
  processWutDraftEvents,
  beginWutDraftEvent,
  pickWutDraftItem,
  forceWutDraftAutopick,
  extendWutDraftPickDeadline,
  saveWutDraftEventDeck,
  attachWutDraftEventTrinket,
  detachWutDraftEventTrinket,
  finishWutDraftDeckbuilding,
  extendWutDraftDeckbuilding,
  getWutDraftEventMatch,
  commitWutDraftEventTurn,
  completeWutDraftEventReveal,
  advanceWutDraftEventRound,
  awardWutDraftEventPrizes,
  rescheduleWutDraftEvent
} from './db.js';
import {
  initializePostgresRuntime,
  loadPostgresStateSnapshot,
  postgresEnabled,
  postgresPool
} from './database/runtime.js';
import {
  authenticatePostgres,
  getAdminSettingsPostgres,
  getPendingWutDraftActionEventIdsPostgres,
  getUserByIdPostgres,
  getWutMembershipStatePostgres,
  hasPendingArenaTurnPostgres
} from './database/repositories/appRead.js';
import {
  getCasinoStateForUserPostgres,
  spinCasinoSlotsPostgres
} from './database/repositories/casinoSlots.js';
import {
  getShotDoctorStateForUserPostgres,
  startShotDoctorRunPostgres,
  submitShotDoctorGuessPostgres
} from './database/repositories/shotDoctor.js';
import {
  addHorseRaceChatMessagePostgres,
  buyHorsePostgres,
  claimHorseOwnerWinningsPostgres,
  controlCurrentHorseRacePostgres,
  getHorseRaceChatStatePostgres,
  getHorseRaceStateForUserPostgres,
  placeOrUpdateHorseRaceBetPostgres,
  processCurrentHorseRacePostgres,
  saveHorseRacingConfigPostgres
} from './database/repositories/horseRacing.js';
import {
  cancelOpenBetPostgres,
  placeOrUpdatePropBetPostgres,
  placeOrUpdateSeriesBetPostgres,
  resetBetsForWeekPostgres,
  settleBetsPostgres,
  correctSettledBetPostgres,
  voidBetByIdPostgres,
  voidBetsForSeriesPostgres,
  voidDeprecatedHatTrickBetsForWeekPostgres
} from './database/repositories/sportsbook.js';
import {
  getBalanceSummaryForUserPostgres,
  getUserBetsBySeriesPostgres,
  getUserBetsPostgres,
  getUserPropBetsByCategoryPostgres
} from './database/repositories/sportsbookRead.js';
import { advanceWeekPostgres, patchSettingsPostgres, setMaintenanceModePostgres, setWeekLockedPostgres } from './database/repositories/appSettings.js';
import { adjustWutCoinBalancePostgres } from './database/repositories/wutAdmin.js';
import {
  saveCardsConfigPostgres,
  grantCardsTestItemPostgres,
  saveCalculatedCardTiersPostgres,
  setCardsPlayerOverridesPostgres,
  setCardsPositionOverridePostgres,
  setCardsTierOverridePostgres,
  setWutFreeShopPurchasesPostgres
} from './database/repositories/cardsAdmin.js';
import { getCardsAdminStatePostgres, getCardsConfigPostgres, getCardsMetaPostgres } from './database/repositories/cardsRead.js';
import { createPostgresJsonBackup, serializePostgresState } from './database/backups.js';
import { getDraftEventLobbyPostgres } from './database/repositories/draftEventStore.js';
import {
  createWutDraftEventPostgres,
  getWutDraftEventPresetsPostgres,
  joinWutDraftEventPostgres,
  pauseWutDraftEventPostgres,
  rescheduleWutDraftEventPostgres,
  resumeWutDraftEventPostgres,
  saveWutDraftEventPresetPostgres,
  transitionWutDraftEventPostgres,
  withdrawWutDraftEventPostgres
} from './database/repositories/draftEvents.js';
import {
  beginWutDraftEventPostgres,
  extendWutDraftPickDeadlinePostgres,
  forceWutDraftAutopickPostgres,
  pickWutDraftItemPostgres,
  startWutDraftEventPostgres
} from './database/repositories/draftGameplay.js';
import {
  attachWutDraftEventTrinketPostgres,
  detachWutDraftEventTrinketPostgres,
  saveWutDraftEventDeckPostgres
} from './database/repositories/draftDecks.js';
import {
  beginWutDraftSafetyBenchPostgres,
  extendWutDraftSafetyBenchPostgres,
  finishWutDraftSafetyBenchPostgres,
  voteWutDraftSafetyBenchPostgres
} from './database/repositories/draftBench.js';
import {
  commitWutDraftEventTurnPostgres,
  completeWutDraftEventMatchPostgres,
  completeWutDraftEventRevealPostgres,
  advanceWutDraftEventRoundPostgres,
  awardWutDraftEventPrizesPostgres,
  dropWutDraftEventEntrantPostgres,
  extendWutDraftDeckbuildingPostgres,
  finishWutDraftDeckbuildingPostgres,
  getDraftMatchesNeedingScoringPostgres,
  resetCurrentWutDraftEventRoundPostgres,
  resolveWutDraftEventMatchPostgres
} from './database/repositories/draftTournament.js';
import { processWutDraftEventsPostgres } from './database/repositories/draftScheduler.js';
import { joinWutPostgres, openWutStarterPackPostgres } from './database/repositories/wutOnboarding.js';
import { claimWutMissionByIdPostgres, setWutMissionBetOpportunitiesPostgres } from './database/repositories/wutMissions.js';
import { adjustUserBalancePostgres, applyWeeklyAllowancePostgres } from './database/repositories/walletAdmin.js';
import { addUserPostgres, adjustAllUserBalancesPostgres, updateUserDetailsPostgres } from './database/repositories/userAdmin.js';
import {
  getAdminSettledBetsPostgres,
  getAdminBetsForWeekPostgres,
  getCasinoSummaryPostgres,
  getOpenBetCountForWeekPostgres,
  getUserSummariesPostgres,
  getVoidRefundsForWeekPostgres
} from './database/repositories/adminRead.js';
import {
  clearPropPlayerOverrideForWeekPostgres,
  getOddsAdjustmentsForWeekPostgres,
  savePropDefaultOddsForWeekPostgres,
  savePropPlayerOverrideForWeekPostgres,
  saveSeriesOddsForWeekPostgres,
  saveSeriesPropForWeekPostgres,
  saveSeriesPropsForWeekPostgres
} from './database/repositories/oddsAdmin.js';
import { getLeaderboardsPostgres, getTopWeeklyBetsPostgres, getUserSettledBetHistoryPostgres, getWeeklyBetTotalByTeamPostgres } from './database/repositories/homeRead.js';
import { createCardsPackPurchasePostgres, claimCardsPackPostgres } from './database/repositories/wutPacks.js';
import { saveWutDeckPostgres, buyWutDeckSlotPostgres } from './database/repositories/wutDecks.js';
import { buyWutTrinketPostgres, rerollWutTrinketShopPostgres } from './database/repositories/wutShop.js';
import { attachWutTrinketPostgres, removeWutTrinketPostgres } from './database/repositories/wutTrinkets.js';
import {
  getCardsOwnedStatePostgres,
  getPendingCardsPackPostgres,
  getWutSystemsStatePostgres
} from './database/repositories/wutRead.js';
import { getArenaAdminMatchStatePostgres, getArenaMatchesNeedingScoringPostgres, getArenaStateForUserPostgres } from './database/repositories/arenaRead.js';
import {
  adminVoidArenaMatchPostgres,
  autoAssignExpiredArenaTurnsPostgres,
  commitArenaTurnPostgres,
  completeArenaMatchPostgres,
  completeArenaRevealPostgres,
  recalculateArenaEloFromHistoryPostgres
} from './database/repositories/arenaMatch.js';
import { assignArenaMatchupsPostgres, enterArenaQueuePostgres } from './database/repositories/arenaQueue.js';
import { commitWutDebugPlacementPostgres, completeWutDebugMatchPostgres, getWutDebugMatchesNeedingScoringPostgres, getWutDebugMatchPostgres, resetWutDebugMatchPostgres } from './database/repositories/arenaDebug.js';
import { getUpcomingSeries, buildMarketsForSeries, getPropBoards, getAvailableSeasons, getGoalTotalForSeries, getPlayers } from './services/wcplData.js';
import { buildShotDoctorRunShots } from './services/shotDoctor.js';
import { buildWeekSettlementResults, evaluateBetAgainstResults } from './services/settlement.js';
import { buildSeriesOddsRecommendations } from './services/oddsRecommendations.js';
import { buildWeeklyPropMarkets, propMarketsToBettingBoards } from './services/weeklyPropMarkets.js';
import { buildLeaderPropRecommendations } from './services/leaderPropRecommendations.js';
import {
  BOOST_TYPES,
  CARD_STARS,
  CARD_COOLDOWNS,
  DEFAULT_BOOST_EFFECTS,
  applyChemistryBonus,
  applyWutPositiveScoring,
  boostFantasyBonus,
  buildFantasyBreakdown,
  buildCardPlayerCatalog,
  generateBoostPack,
  generatePlayerPack,
  generateWutPlayerPack,
  availableWutMatchCards,
  generateWutStarterPack,
  chemistryMultiplierForCount,
  captainPatchChemistry,
  wutChemistryKey,
  getCardSeriesOptions,
  scoreCardSeries,
  scoreHistoricalCardSample,
  resolveWutMatchingTrinkets
} from './services/cards.js';
import { HORSE_RACING_CONFIG } from './services/horseRacing.js';
import {
  adjacentWutSlots,
  resolveJourneymanIdentity,
  resolveZebraStripes,
  trinketFitsWutPosition,
  WUT_TRINKET_ADMIN_FIELDS
} from './services/wutBalanceRules.js';
import {
  WUT_TRINKET_ICONS,
  wutTitleCase,
  wutTrinketDescription,
  wutTrinketName
} from './services/wutTrinketText.js';
import {
  WUT_DRAFT_TRANSITIONS,
  WUT_EVENT_TIME_ZONE,
  hydrateWutDraftCardPlayer,
  isWutDraftEventLobbyVisible,
  snapshotWutDraftCard,
  splitWutDraftCardPools
} from './services/wutDraftEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
app.locals.WUT_TRINKET_ICONS = WUT_TRINKET_ICONS;
app.locals.wutTitleCase = wutTitleCase;
app.locals.wutTrinketDescription = wutTrinketDescription;
app.locals.wutTrinketName = wutTrinketName;
let liveCardsConfigCache = getCardsConfig();
app.locals.wutTrinketPower = rarity => Number(liveCardsConfigCache.wut?.trinketPowerValues?.[String(rarity || '').toLowerCase()] || 0);
const wutPacificParts = value => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: WUT_EVENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
};
app.locals.wutPacificInput = value => {
  const parts = wutPacificParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : '';
};
app.locals.wutPacificDateTime = value => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: WUT_EVENT_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(new Date(value));
};
if (postgresEnabled) {
  await initializePostgresRuntime();
  initDbFromPostgresSnapshot(await loadPostgresStateSnapshot());
  liveCardsConfigCache = await getCardsConfigPostgres(postgresPool());
} else {
  initDb();
}

// Keep time-based race transitions moving even when nobody has the page open.
// The interval is deliberately unref'd so it never prevents a clean shutdown.
const horseRaceClock = setInterval(() => {
  Promise.resolve().then(async () => {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    if (settings.maintenanceMode) return;
    if (postgresEnabled) await processCurrentHorseRacePostgres(postgresPool(), new Date());
    else processCurrentHorseRace(new Date());
  }).catch(err => console.error('Horse race clock failed:', err));
}, 5000);
horseRaceClock.unref?.();

let arenaClockBusy = false;

let horseChatCooldownCardDate = null;
const horseChatCooldowns = new Map();

function syncHorseChatCooldowns(cardDate) {
  if (horseChatCooldownCardDate !== cardDate) {
    horseChatCooldownCardDate = cardDate;
    horseChatCooldowns.clear();
  }
}

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

app.use(async (req, res, next) => {
  try {
    const pool = postgresEnabled ? postgresPool() : null;
    res.locals.currentUser = req.session.userId
      ? (postgresEnabled ? await getUserByIdPostgres(pool, req.session.userId) : getUserById(req.session.userId))
      : null;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    const adminSettings = postgresEnabled ? await getAdminSettingsPostgres(pool) : getAdminSettings();
    res.locals.currentWeek = adminSettings.currentWeek;
    res.locals.bettingLocked = adminSettings.currentWeekLocked;
    res.locals.weeklyAllowance = adminSettings.weeklyAllowance;
    res.locals.seasonId = adminSettings.seasonId;
    res.locals.casinoOpen = adminSettings.casinoOpen;
    res.locals.casinoLinkVisible = adminSettings.casinoLinkVisible;
    res.locals.cardsOpen = adminSettings.cardsOpen;
    res.locals.cardsLinkVisible = adminSettings.cardsLinkVisible;
    if (res.locals.currentUser && postgresEnabled) {
      [res.locals.wutArenaTurnPending, res.locals.wutDraftActionEventIds] = await Promise.all([
        hasPendingArenaTurnPostgres(pool, res.locals.currentUser.id),
        getPendingWutDraftActionEventIdsPostgres(pool, res.locals.currentUser.id)
      ]);
    } else {
      res.locals.wutArenaTurnPending = res.locals.currentUser ? hasPendingArenaTurn(res.locals.currentUser.id) : false;
      res.locals.wutDraftActionEventIds = res.locals.currentUser ? getPendingWutDraftActionEventIds(res.locals.currentUser.id) : [];
    }
    res.locals.wutDraftTurnPending = res.locals.wutDraftActionEventIds.length > 0;
    res.locals.wutTurnPending = res.locals.wutArenaTurnPending || res.locals.wutDraftTurnPending;
    res.locals.maxBet = Number(process.env.MAX_BET || 250);
    res.locals.propMaxBet = Number(process.env.PROP_MAX_BET || 100);
    res.locals.goalTotalLine = Number(process.env.GOAL_TOTAL_LINE || 10.5);
    res.locals.goalTotalBoost = Number(process.env.GOAL_TOTAL_BOOST || 1.5);
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/health', async (req, res) => {
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  res.json({ ok: true, storage: process.env.STORAGE_BACKEND || 'json', maintenance: Boolean(settings.maintenanceMode) });
});

app.use(async (req, res, next) => {
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  if (!settings.maintenanceMode || res.locals.currentUser?.role === 'admin' || ['/login', '/logout', '/health'].includes(req.path)) return next();
  res.set('Retry-After', '300');
  return res.status(503).render('maintenance', { maintenanceMessage: settings.maintenanceMessage });
});

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    req.session.flash = { type: 'error', message: 'Please log in first.' };
    return res.redirect('/login');
  }
  next();
}

async function requireWutReady(req, res, next) {
  const membership = postgresEnabled
    ? await getWutMembershipStatePostgres(postgresPool(), req.session.userId)
    : getWutMembershipState(req.session.userId);
  if (!membership.joined || !membership.starterOpened) {
    req.session.flash = { type: 'error', message: 'Join WUT and open your starter pack first.' };
    return res.redirect('/cards');
  }
  next();
}

async function requireWutOpen(req, res, next) {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    if (settings.cardsOpen) return next();
    req.session.flash = { type: 'error', message: 'WUT is currently closed.' };
    return res.redirect('/cards');
  } catch (err) { return next(err); }
}

async function getBettingView(req) {
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  const currentWeek = Number(settings.currentWeek || 1);
  const locked = postgresEnabled ? (settings.lockedWeeks || []).map(Number).includes(currentWeek) : isWeekLocked(currentWeek);
  return { view: 'current', week: currentWeek, locked, openWeek: currentWeek };
}

async function getBetClosureState({ seasonId, week }) {
  const weekResults = await buildWeekSettlementResults({ seasonId, week });
  const completedSeriesKeys = new Set(
    Object.values(weekResults.seriesResults || {})
      .filter(result => result.complete)
      .map(result => result.series_key)
  );
  const closedDivisionIds = new Set(
    Object.values(weekResults.seriesResults || {})
      .filter(result => result.complete)
      .map(result => result.division_id)
  );
  return { weekResults, completedSeriesKeys, closedDivisionIds };
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

async function buildWutMissionBetOpportunities({ seasonId, week }) {
  // Once betting is locked, rebuild the complete published board rather than
  // filtering markets that have since closed or completed. This matters when
  // WUT is deployed/reset after the lock snapshot would normally be created.
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  const preserveLockedBoard = postgresEnabled ? (settings.lockedWeeks || []).map(Number).includes(Number(week)) : isWeekLocked(week);
  const activeOdds = postgresEnabled ? await getOddsAdjustmentsForWeekPostgres(postgresPool(), week) : getOddsAdjustmentsForWeek(week);
  const [series, closureState, rawPropBoards, seriesPropMarkets] = await Promise.all([
    getUpcomingSeries(week, seasonId),
    getBetClosureState({ seasonId, week }),
    getPropBoards(week, seasonId, activeOdds),
    buildWeeklyPropMarkets({ seasonId, week, odds: activeOdds, publishedOnly: true })
  ]);
  const basePropBoards = await filterLeaderPropPools(rawPropBoards, { seasonId, week });
  const propBoards = propMarketsToBettingBoards(seriesPropMarkets, basePropBoards);
  const opportunities = series
    .filter(item => preserveLockedBoard || !closureState.completedSeriesKeys.has(item.series_key))
    .map(item => ({
      key: `series:${item.series_key}`,
      kind: 'series',
      divisionId: item.division_id,
      label: `${item.away_team_name} at ${item.home_team_name}`
    }));

  for (const board of propBoards) {
    if (!preserveLockedBoard && closureState.closedDivisionIds.has(board.division_id)) continue;
    for (const category of board.categories || []) {
      if (!category.prop_key || !(category.players || []).length) continue;
      opportunities.push({
        key: `prop:${category.prop_key}`,
        kind: 'prop',
        divisionId: board.division_id,
        label: `${board.division_name || board.division_id} ${category.title}`
      });
    }
  }
  return opportunities;
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

function betReviewGroupKey(bet) {
  const kind = String(bet.bet_kind || 'series');
  if (kind === 'prop') {
    return [
      kind,
      bet.market_key || bet.prop_key || '',
      bet.player_key || '',
      bet.quantity ?? '',
      bet.prop_line ?? ''
    ].join('|');
  }
  return [
    kind,
    bet.market_key || bet.label || '',
    bet.goal_total_side || '',
    bet.goal_total_line ?? ''
  ].join('|');
}

async function buildSeriesBetReview({ seasonId, week, series, bets }) {
  const divisions = [...new Set(series.map(item => item.division_id))];
  const playerRows = await Promise.all(divisions.map(async divisionId => ({
    divisionId,
    players: await getPlayers(divisionId, seasonId)
  })));
  const playerTeams = new Map();
  for (const division of playerRows) {
    for (const player of division.players) {
      playerTeams.set(
        `${division.divisionId}|${String(player.player_key || '').trim()}`,
        String(player.team_id || '').trim()
      );
    }
  }

  const reviewBySeries = new Map(series.map(item => [item.series_key, {
    ...item,
    matchup_label: `${item.away_team_name} at ${item.home_team_name}`,
    groupsByKey: new Map()
  }]));

  for (const bet of bets) {
    const directSeriesKey = String(bet.series_key || '').trim();
    let matchingSeries = directSeriesKey && reviewBySeries.has(directSeriesKey)
      ? [reviewBySeries.get(directSeriesKey)]
      : [];

    if (!matchingSeries.length && bet.bet_kind === 'prop') {
      const playerTeamId = String(
        bet.player_team_id ||
        playerTeams.get(`${bet.division_id}|${String(bet.player_key || '').trim()}`) ||
        ''
      ).trim();
      if (playerTeamId) {
        matchingSeries = series
          .filter(item =>
            item.division_id === bet.division_id &&
            [item.home_team_id, item.away_team_id].includes(playerTeamId)
          )
          .map(item => reviewBySeries.get(item.series_key));
      }
    }

    for (const review of matchingSeries) {
      const key = betReviewGroupKey(bet);
      if (!review.groupsByKey.has(key)) {
        review.groupsByKey.set(key, {
          key,
          bet_kind: bet.bet_kind || 'series',
          label: bet.label,
          total_stake: 0,
          total_payout: 0,
          bet_count: 0,
          settled_count: 0,
          winning_count: 0,
          open_count: 0,
          bets: []
        });
      }
      const group = review.groupsByKey.get(key);
      group.total_stake += Number(bet.stake || 0);
      group.bet_count += 1;
      if (bet.status === 'settled') {
        group.settled_count += 1;
        group.total_payout += Number(bet.payout || 0);
        if (bet.won) group.winning_count += 1;
      } else {
        group.open_count += 1;
      }
      group.bets.push(bet);
    }
  }

  return [...reviewBySeries.values()].map(review => {
    const groups = [...review.groupsByKey.values()]
      .map(group => ({
        ...group,
        bets: group.bets.sort((a, b) =>
          Number(b.stake || 0) - Number(a.stake || 0) ||
          String(a.user_display_name || '').localeCompare(String(b.user_display_name || ''))
        )
      }))
      .sort((a, b) =>
        String(a.bet_kind).localeCompare(String(b.bet_kind)) ||
        Number(b.total_stake) - Number(a.total_stake) ||
        String(a.label).localeCompare(String(b.label))
      );
    return {
      ...review,
      groupsByKey: undefined,
      groups,
      bet_count: groups.reduce((sum, group) => sum + group.bet_count, 0),
      total_stake: groups.reduce((sum, group) => sum + group.total_stake, 0),
      total_payout: groups.reduce((sum, group) => sum + group.total_payout, 0)
    };
  });
}


async function settleCompletedBetsOrThrow({ week, seasonId }) {
  const weekResults = await buildWeekSettlementResults({ seasonId, week });
  const bets = postgresEnabled
    ? await getAdminBetsForWeekPostgres(postgresPool(), week)
    : undefined;
  const preview = buildSettlementPreview({
    week,
    weekResults,
    evaluator: evaluateBetAgainstResults,
    bets
  });

  const evaluations = Object.fromEntries(preview.rows.map(r => [r.id, {
    ready: r.ready,
    won: r.won,
    reason: r.evaluation_reason,
    result_summary: r.result_summary
  }]));

  return postgresEnabled
    ? settleBetsPostgres(postgresPool(), { week, results: { evaluations } })
    : settleCompletedBets({ week, results: { evaluations } });
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
  const bets = postgresEnabled
    ? await getAdminBetsForWeekPostgres(postgresPool(), week)
    : undefined;
  const preview = buildSettlementPreview({
    week,
    weekResults,
    evaluator: evaluateBetAgainstResults,
    bets
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

  return postgresEnabled
    ? settleBetsPostgres(postgresPool(), { week, results: { evaluations } })
    : settleWeek({ week, results: { evaluations } });
}

async function buildSettledBetAudit({ seasonId }) {
  const settledBets = postgresEnabled
    ? await getAdminSettledBetsPostgres(postgresPool())
    : getAdminSettledBets();
  const byWeek = new Map();
  for (const bet of settledBets) {
    const week = Number(bet.week);
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(bet);
  }

  const rows = [];
  const errors = [];
  let validated = 0;
  let unable = 0;
  await Promise.all([...byWeek.entries()].map(async ([week, bets]) => {
    try {
      const weekResults = await buildWeekSettlementResults({ seasonId, week });
      for (const bet of bets) {
        const evaluation = evaluateBetAgainstResults(bet, weekResults);
        if (!evaluation.ready) {
          unable += 1;
          continue;
        }
        validated += 1;
        const expectedPayout = evaluation.won
          ? Math.ceil(Number(bet.stake || 0) * Number(bet.multiplier || 0))
          : 0;
        const storedPayout = Number(bet.payout || 0);
        if (Boolean(bet.won) !== Boolean(evaluation.won) || storedPayout !== expectedPayout) {
          rows.push({
            ...bet,
            stored_won: Boolean(bet.won),
            stored_payout: storedPayout,
            expected_won: Boolean(evaluation.won),
            expected_payout: expectedPayout,
            payout_delta: expectedPayout - storedPayout,
            expected_summary: evaluation.result_summary || evaluation.reason || ''
          });
        }
      }
    } catch (err) {
      unable += bets.length;
      errors.push(`Week ${week}: ${err.message}`);
    }
  }));

  rows.sort((a, b) => Number(b.week) - Number(a.week) || Number(a.id) - Number(b.id));
  return {
    seasonId,
    total: settledBets.length,
    validated,
    correct: validated - rows.length,
    unable,
    rows,
    errors
  };
}

app.get('/', async (req, res, next) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const currentWeek = Number(settings.currentWeek || 1);
    const formatLeaderboard = rows => rows.map(u => ({
      ...u,
      last_week_display: formatSigned(u.last_week_change),
      current_week_display: formatSigned(u.current_week_change)
    }));
    const liveLeaderboards = postgresEnabled ? await getLeaderboardsPostgres(postgresPool(), currentWeek) : null;
    const leaderboard = formatLeaderboard(liveLeaderboards ? liveLeaderboards.betting : getLeaderboard(currentWeek, false));
    const overallLeaderboard = formatLeaderboard(liveLeaderboards ? liveLeaderboards.overall : getLeaderboard(currentWeek, true));
    const series = await getUpcomingSeries(currentWeek, settings.seasonId);
    const teamTotals = applyTeamNamesToTotals(postgresEnabled ? await getWeeklyBetTotalByTeamPostgres(postgresPool(), currentWeek) : getWeeklyBetTotalByTeam(currentWeek), series);
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
const topBets = (postgresEnabled ? await getTopWeeklyBetsPostgres(postgresPool(), currentWeek, null) : getTopWeeklyBets(currentWeek, null)).map(b => ({
  ...b,
  label: formatTopBetLabel(b.label)
}));
    const currentUserBalance = req.session.userId ? (postgresEnabled ? await getBalanceSummaryForUserPostgres(postgresPool(), req.session.userId) : getBalanceSummaryForUser(req.session.userId)) : null;
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

app.post('/login', async (req, res) => {
  const user = postgresEnabled
    ? await authenticatePostgres(postgresPool(), req.body.username || '', req.body.password || '')
    : authenticate(req.body.username || '', req.body.password || '');
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

app.get('/history', requireLogin, async (req, res) => {
  const history = postgresEnabled ? await getUserSettledBetHistoryPostgres(postgresPool(), req.session.userId) : getUserSettledBetHistory(req.session.userId);
  res.render('history', { history });
});

app.get('/casino', requireLogin, async (req, res) => {
  const casinoState = postgresEnabled
    ? await getCasinoStateForUserPostgres(postgresPool(), req.session.userId)
    : getCasinoStateForUser(req.session.userId);
  const lastSpin = req.session.lastCasinoSpin || null;
  const lastWager = Number(req.session.lastCasinoWager || casinoState.allowedWagers[0] || 10);
  delete req.session.lastCasinoSpin;
  res.render('casino', { casinoState, lastSpin, lastWager });
});

app.post('/casino/slots/spin', requireLogin, async (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const spin = postgresEnabled ? await spinCasinoSlotsPostgres(postgresPool(), {
      userId: req.session.userId,
      wager: req.body.wager
    }) : spinCasinoSlots({
      userId: req.session.userId,
      wager: req.body.wager
    });
    req.session.lastCasinoSpin = spin;
    req.session.lastCasinoWager = spin.wager;

    if (wantsJson) {
      const casinoState = postgresEnabled
        ? await getCasinoStateForUserPostgres(postgresPool(), req.session.userId)
        : getCasinoStateForUser(req.session.userId);
      return res.json({ ok: true, spin, casinoState });
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

app.get('/casino/horse-racing', requireLogin, async (req, res) => {
  const horseRaceState = postgresEnabled
    ? await getHorseRaceStateForUserPostgres(postgresPool(), { userId: req.session.userId })
    : getHorseRaceStateForUser(req.session.userId);
  res.render('horse_racing', { horseRaceState });
});

app.get('/casino/horse-racing/state', requireLogin, async (req, res) => {
  const horseRaceState = postgresEnabled
    ? await getHorseRaceStateForUserPostgres(postgresPool(), { userId: req.session.userId })
    : getHorseRaceStateForUser(req.session.userId);
  res.json({ ok: true, horseRaceState });
});

app.post('/casino/horse-racing/bet', requireLogin, async (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const input = {
      userId: req.session.userId,
      horseId: req.body.horse_id,
      stake: req.body.stake
    };
    const result = postgresEnabled
      ? await placeOrUpdateHorseRaceBetPostgres(postgresPool(), input)
      : placeOrUpdateHorseRaceBet(input);
    const horseRaceState = postgresEnabled
      ? await getHorseRaceStateForUserPostgres(postgresPool(), { userId: req.session.userId })
      : getHorseRaceStateForUser(req.session.userId);
    if (wantsJson) return res.json({ ok: true, result, horseRaceState });
    req.session.flash = { type: 'success', message: `Race wager ${result.action}.` };
    return res.redirect('/casino/horse-racing');
  } catch (err) {
    if (wantsJson) return res.status(400).json({ ok: false, error: err.message });
    req.session.flash = { type: 'error', message: err.message };
    return res.redirect('/casino/horse-racing');
  }
});

app.post('/casino/horse-racing/horses/buy', requireLogin, async (req, res) => {
  try {
    const input = { userId: req.session.userId, name: req.body.name };
    const horse = postgresEnabled ? await buyHorsePostgres(postgresPool(), input) : buyHorse(input);
    req.session.flash = { type: 'success', message: `${horse.name} has joined the horse pool.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/casino/horse-racing#horse-ownership');
});

app.post('/casino/horse-racing/horses/claim', requireLogin, async (req, res) => {
  try {
    const input = { userId: req.session.userId, horseId: req.body.horse_id };
    const result = postgresEnabled ? await claimHorseOwnerWinningsPostgres(postgresPool(), input) : claimHorseOwnerWinnings(input);
    req.session.flash = { type: 'success', message: `${result.amount} Mushybux collected from ${result.horseName}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/casino/horse-racing#owned-horses');
});

app.get('/casino/horse-racing/chat', requireLogin, async (req, res) => {
  const now = new Date();
  const chat = postgresEnabled ? await getHorseRaceChatStatePostgres(postgresPool(), now) : getHorseRaceChatState(now);
  syncHorseChatCooldowns(chat.cardDate);
  res.json({
    ok: true,
    open: chat.open,
    closesAt: chat.closesAt,
    resetAt: chat.resetAt,
    messages: chat.messages
  });
});

app.post('/casino/horse-racing/chat', requireLogin, async (req, res) => {
  const now = new Date();
  const chat = postgresEnabled ? await getHorseRaceChatStatePostgres(postgresPool(), now) : getHorseRaceChatState(now);
  syncHorseChatCooldowns(chat.cardDate);
  if (!chat.open) {
    return res.status(400).json({ ok: false, error: 'Race chat is currently closed.' });
  }

  const message = String(req.body.message || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'Enter a message first.' });
  if (message.length > HORSE_RACING_CONFIG.chatMaxLength) {
    return res.status(400).json({ ok: false, error: `Messages are limited to ${HORSE_RACING_CONFIG.chatMaxLength} characters.` });
  }

  const userId = Number(req.session.userId);
  const lastSentAt = Number(horseChatCooldowns.get(userId) || 0);
  if (now.getTime() - lastSentAt < HORSE_RACING_CONFIG.chatCooldownMs) {
    return res.status(429).json({ ok: false, error: 'Easy, jockey. Wait two seconds between messages.' });
  }

  const user = res.locals.currentUser;
  const input = {
    userId,
    username: user?.display_name || user?.username || `User ${userId}`,
    message,
    now
  };
  const chatMessage = postgresEnabled
    ? await addHorseRaceChatMessagePostgres(postgresPool(), input)
    : addHorseRaceChatMessage(input);
  horseChatCooldowns.set(userId, now.getTime());
  res.json({ ok: true, message: chatMessage });
});

app.post('/casino/horse-racing/admin/:action', requireAdmin, async (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const result = postgresEnabled
      ? await controlCurrentHorseRacePostgres(postgresPool(), req.params.action)
      : controlCurrentHorseRace(req.params.action);
    if (wantsJson) {
      return res.json({
        ok: true,
        result,
        horseRaceState: postgresEnabled
          ? await getHorseRaceStateForUserPostgres(postgresPool(), { userId: req.session.userId })
          : getHorseRaceStateForUser(req.session.userId)
      });
    }
    req.session.flash = { type: 'success', message: `Horse race debug command: ${result.action}.` };
  } catch (err) {
    if (wantsJson) return res.status(400).json({ ok: false, error: err.message });
    req.session.flash = { type: 'error', message: err.message };
  }
  return res.redirect('/casino/horse-racing');
});


app.get('/casino/puckIQ', requireLogin, async (req, res) => {
  const shotDoctorState = postgresEnabled
    ? await getShotDoctorStateForUserPostgres(postgresPool(), req.session.userId)
    : getShotDoctorStateForUser(req.session.userId);
  res.render('shot_doctor', { shotDoctorState });
});

app.post('/casino/puckIQ/start', requireLogin, async (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const shotDoctorState = postgresEnabled
      ? await getShotDoctorStateForUserPostgres(postgresPool(), req.session.userId)
      : getShotDoctorStateForUser(req.session.userId);
    const shots = await buildShotDoctorRunShots();
    const payload = postgresEnabled ? await startShotDoctorRunPostgres(postgresPool(), {
      userId: req.session.userId,
      wager: shotDoctorState.entryFee,
      shots
    }) : startShotDoctorRun({
      userId: req.session.userId,
      wager: shotDoctorState.entryFee,
      shots
    });

    if (wantsJson) {
      const nextState = postgresEnabled
        ? await getShotDoctorStateForUserPostgres(postgresPool(), req.session.userId)
        : getShotDoctorStateForUser(req.session.userId);
      return res.json({ ok: true, ...payload, shotDoctorState: nextState });
    }
    return res.redirect('/casino/puckIQ');
  } catch (err) {
    if (wantsJson) return res.status(400).json({ ok: false, error: err.message });
    req.session.flash = { type: 'error', message: err.message };
    return res.redirect('/casino/puckIQ');
  }
});

app.post('/casino/puckIQ/guess', requireLogin, async (req, res) => {
  const wantsJson = req.xhr || String(req.get('accept') || '').includes('application/json');
  try {
    const payload = postgresEnabled ? await submitShotDoctorGuessPostgres(postgresPool(), {
      userId: req.session.userId,
      runId: req.body.run_id,
      guess: req.body.guess
    }) : submitShotDoctorGuess({
      userId: req.session.userId,
      runId: req.body.run_id,
      guess: req.body.guess
    });

    if (wantsJson) {
      const nextState = postgresEnabled
        ? await getShotDoctorStateForUserPostgres(postgresPool(), req.session.userId)
        : getShotDoctorStateForUser(req.session.userId);
      return res.json({ ok: true, ...payload, shotDoctorState: nextState });
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

async function getCardsCatalog() {
  const admin = postgresEnabled ? await getCardsMetaPostgres(postgresPool()) : getCardsAdminState();
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  return buildCardPlayerCatalog({
    seasonId: settings.seasonId,
    positionOverrides: admin.positionOverrides,
    tierOverrides: admin.tierOverrides,
    scoringConfig: admin.config.scoring
  });
}

async function getLiveCardsConfig() {
  liveCardsConfigCache = postgresEnabled ? await getCardsConfigPostgres(postgresPool()) : getCardsConfig();
  return liveCardsConfigCache;
}

function sortCardsCatalogForAdmin(catalog) {
  const seasonRank = { S1: 1, S2: 2, S3: 3, MYTHIC: 4 };
  const rarityRank = { mythic: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
  return [...catalog].sort((a, b) =>
    (seasonRank[a.edition] || 99) - (seasonRank[b.edition] || 99) ||
    (rarityRank[b.tier] || 0) - (rarityRank[a.tier] || 0) ||
    Number(b.weightedFpPerGame || 0) - Number(a.weightedFpPerGame || 0) ||
    String(a.divisionId || '').localeCompare(String(b.divisionId || '')) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
}

function cardsCatalogMap(catalog) {
  const map = new Map();
  for (const player of catalog) {
    map.set(player.catalogKey, player);
    map.set(player.cardIdentity, player);
    if (player.edition === 'S3') map.set(`${player.divisionId}|${player.playerKey}`, player);
  }
  return map;
}

function decorateOwnedCard(card, catalogByKey) {
  const player = catalogByKey.get(card.card_identity) ||
    catalogByKey.get(`${card.edition || 'S3'}|${card.division_id}|${card.player_key}`) ||
    catalogByKey.get(`${card.division_id}|${card.player_key}`) ||
    {};
  const appearanceEntries = Object.entries(card.fantasy_stats || {});
  const appearances = appearanceEntries.map(([, appearance]) => appearance);
  const wutMatchAppearances = appearanceEntries
    .filter(([key]) => key.startsWith('arena-'))
    .map(([, appearance]) => appearance);
  const wutMatchFp = wutMatchAppearances.reduce((sum, appearance) => sum + Number(appearance?.fp || 0), 0);
  const statKeys = player.position === 'G'
    ? ['saves', 'shotsAgainst', 'goalsAgainst', 'shutouts']
    : ['goals', 'assists', 'shots', 'hits', 'blocks'];
  const fantasyTotals = Object.fromEntries(statKeys.map(key => [
    key,
    appearances.reduce((sum, appearance) => sum + Number(appearance?.stats?.[key] || 0), 0)
  ]));
  if (player.position === 'G') {
    fantasyTotals.savePct = fantasyTotals.shotsAgainst > 0
      ? fantasyTotals.saves / fantasyTotals.shotsAgainst
      : 0;
  }
  return {
    ...card,
    player,
    fantasyAppearances: {
      appearances: appearances.length,
      gamesPlayed: appearances.reduce((sum, appearance) => sum + Number(appearance?.gamesPlayed || 0), 0),
      fp: Number(card.total_fp_for_user || 0),
      stats: fantasyTotals
    },
    wutMatchStats: {
      matchesPlayed: wutMatchAppearances.length,
      fp: wutMatchFp,
      fpPerMatch: wutMatchAppearances.length ? wutMatchFp / wutMatchAppearances.length : 0
    }
  };
}

function boostFitsPosition(boost, position) {
  const goalieBoost = ['save', 'shutout'].includes(boost?.boost_type);
  return position === 'G' ? goalieBoost : !goalieBoost;
}

function boostFitsCard(boost, card) {
  if (!boost || !card) return true;
  return boostFitsPosition(boost, card.player?.position);
}

async function seriesOptionsForCard({ settings, week, card }) {
  if (!card?.player?.position) return [];
  if (card.edition !== 'S3') {
    return [{
      seriesKey: '',
      opponentTeamId: '',
      opponentTeamName: 'Historical sample',
      historical: true,
      voided: false
    }];
  }
  return getCardSeriesOptions({
    seasonId: settings.seasonId,
    week,
    divisionId: card.player.divisionId,
    teamId: card.player.teamId
  });
}

async function scoreOwnedCardLineup({ settings, week, row, card, boost }) {
  if (!card?.player?.position) return null;
  const cardsConfig = await getLiveCardsConfig();
  const scoringBoost = boost ? {
    ...boost,
    effect: cardsConfig.boostEffects?.[boost.boost_type]?.[boost.rarity] || boost.effect
  } : null;
  if (card.edition !== 'S3') {
    return scoreHistoricalCardSample({
      player: card.player,
      position: card.player.position,
      boost: scoringBoost,
      scoringConfig: cardsConfig.scoring,
      sampleMatchIds: row.sample_match_ids || [],
      syntheticGames: row.synthetic_games || []
    });
  }
  if (!row.selected_series_key) return null;
  return scoreCardSeries({
    seasonId: settings.seasonId,
    divisionId: card.player.divisionId,
    player: card.player,
    position: card.player.position,
    seriesKey: row.selected_series_key,
    boost: scoringBoost,
    scoringConfig: cardsConfig.scoring
  });
}

function chemistryBonusForCard({ lineup, ownedCards, catalogByKey, card }) {
  const chemistryKey = wutChemistryKey(card?.player);
  if (!chemistryKey) return { count: 0, multiplier: 1 };
  let count = 0;
  for (const row of lineup || []) {
    if (!row.card_id) continue;
    const ownedCard = ownedCards.find(item => Number(item.id) === Number(row.card_id));
    const decorated = ownedCard ? decorateOwnedCard(ownedCard, catalogByKey) : null;
    if (wutChemistryKey(decorated?.player) === chemistryKey) count += 1;
  }
  return { count, multiplier: chemistryMultiplierForCount(count, liveCardsConfigCache.scoring) };
}

function scoreFromResolvedLineup({ row, card, boost }) {
  if (!row?.finalized || !row.stats || !card?.player?.position) return null;
  const scoringConfig = liveCardsConfigCache.scoring;
  const breakdown = buildFantasyBreakdown(row.stats, card.player.position, boost, {
    unavailableStats: card.player.unavailableStats || [],
    scoringConfig
  });
  const exact = breakdown.reduce((sum, item) => sum + Number(item.points || 0), 0);
  const fantasyWeek = card.fantasy_stats?.[String(row.week)] || {};
  return {
    gamesPlayed: Number(fantasyWeek.gamesPlayed || row.sample_match_ids?.length || row.synthetic_games?.length || 0),
    fp: Math.round(exact),
    exactFp: exact,
    stats: row.stats,
    sampleMatchIds: row.sample_match_ids || fantasyWeek.sampleMatchIds || [],
    syntheticGames: row.synthetic_games || fantasyWeek.syntheticGames || [],
    breakdown
  };
}

async function refreshResolvedChemistryForUserWeek(userId, week, catalog = null) {
  const activeCatalog = catalog || await getCardsCatalog();
  const catalogByKey = cardsCatalogMap(activeCatalog);
  const owned = getCardsOwnedState(userId);
  const lineup = getCardsLineup(userId, week);
  let updated = 0;

  for (const row of lineup) {
    if (!row.card_id || !row.finalized || !row.resources_resolved) continue;
    const ownedCard = owned.cards.find(item => Number(item.id) === Number(row.card_id));
    const card = ownedCard ? decorateOwnedCard(ownedCard, catalogByKey) : null;
    const boost = owned.boosts.find(item => Number(item.id) === Number(row.boost_id)) || null;
    const rawScore = scoreFromResolvedLineup({ row, card, boost });
    if (!rawScore) continue;
    const score = applyChemistryBonus(rawScore, chemistryBonusForCard({
      lineup,
      ownedCards: owned.cards,
      catalogByKey,
      card
    }));
    resolveCardsLineupResult({
      userId,
      week,
      slot: row.slot,
      seriesComplete: true,
      ...score,
      sampleMatchIds: score.sampleMatchIds || [],
      syntheticGames: score.syntheticGames || [],
      scoreBreakdown: score.breakdown || [],
      allowResolvedUpdate: true
    });
    updated += 1;
  }

  return updated;
}

async function buildCardsHub(userId) {
  const settings = getAdminSettings();
  const week = Number(settings.currentWeek);
  const catalog = await getCardsCatalog();
  const catalogByKey = cardsCatalogMap(catalog);
  const owned = getCardsOwnedState(userId);
  let lineup = getCardsLineup(userId, week);

  for (const row of lineup) {
    if (!row.card_id || row.resources_resolved) continue;
    const card = owned.cards.find(item => Number(item.id) === Number(row.card_id));
    const decorated = card ? decorateOwnedCard(card, catalogByKey) : null;
    const player = decorated?.player;
    if (!card || !player) continue;
    if (decorated.edition !== 'S3') continue;
    if (decorated.edition === 'S3') {
      if (!row.selected_series_key) continue;
      const options = await getCardSeriesOptions({
        seasonId: settings.seasonId,
        week,
        divisionId: player.divisionId,
        teamId: player.teamId
      });
      const selected = options.find(option => option.seriesKey === row.selected_series_key);
      if (selected?.voided) continue;
    }
    const boost = owned.boosts.find(item => Number(item.id) === Number(row.boost_id)) || null;
    const rawScore = await scoreOwnedCardLineup({ settings, week, row, card: decorated, boost });
    if (!rawScore) continue;
    const score = applyChemistryBonus(rawScore, chemistryBonusForCard({
      lineup,
      ownedCards: owned.cards,
      catalogByKey,
      card: decorated
    }));
    if (score.gamesPlayed > 0) {
      resolveCardsLineupResult({
        userId,
        week,
        slot: row.slot,
        seriesComplete: false,
        ...score,
        sampleMatchIds: score.sampleMatchIds || [],
        syntheticGames: score.syntheticGames || [],
        scoreBreakdown: score.breakdown || []
      });
    }
  }
  await refreshResolvedChemistryForUserWeek(userId, week, catalog);

  const refreshedOwned = getCardsOwnedState(userId);
  lineup = getCardsLineup(userId, week);
  const activeLineupCardIds = new Set(lineup.map(row => Number(row.card_id || 0)).filter(Boolean));
  const rarityRank = { mythic: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
  const decoratedCards = await Promise.all(refreshedOwned.cards
    .filter(card => !activeLineupCardIds.has(Number(card.id)))
    .map(async card => {
    const decorated = decorateOwnedCard(card, catalogByKey);
    decorated.seriesOptions = await seriesOptionsForCard({ settings, week, card: decorated });
    return decorated;
  }));
  const decoratedLineupCards = await Promise.all(refreshedOwned.cards
    .filter(card => activeLineupCardIds.has(Number(card.id)))
    .map(async card => {
      const decorated = decorateOwnedCard(card, catalogByKey);
      decorated.seriesOptions = await seriesOptionsForCard({ settings, week, card: decorated });
      return decorated;
    }));
  const allDecoratedCards = [...decoratedCards, ...decoratedLineupCards];
  decoratedCards.sort((a, b) =>
    (rarityRank[b.player.tier] || 0) - (rarityRank[a.player.tier] || 0) ||
    a.player.name.localeCompare(b.player.name)
  );
  refreshedOwned.boosts.sort((a, b) =>
    (rarityRank[b.rarity] || 0) - (rarityRank[a.rarity] || 0) ||
    a.boost_type.localeCompare(b.boost_type)
  );
  const decoratedLineup = await Promise.all(lineup.map(async row => {
    const card = allDecoratedCards.find(item => Number(item.id) === Number(row.card_id)) || null;
    const boost = refreshedOwned.boosts.find(item => Number(item.id) === Number(row.boost_id)) || null;
    const seriesOptions = card ? await seriesOptionsForCard({ settings, week, card }) : [];
    const selected = seriesOptions.find(option => option.seriesKey === row.selected_series_key);
    return {
      ...row,
      card,
      boost,
      seriesOptions,
      selectedSeries: selected || null,
      breakdown: row.finalized && row.score_breakdown?.length
        ? row.score_breakdown
        : row.finalized && row.stats && card
        ? buildFantasyBreakdown(row.stats, card.player.position, boost, { unavailableStats: card.player.unavailableStats || [], scoringConfig: liveCardsConfigCache.scoring })
        : [],
      warning: selected?.voided
        ? 'This series is postponed or voided. The card and boost will not be consumed.'
        : row.warning
    };
  }));
  const reviews = getCardsWeekReviews(userId);
  const rawPendingReview = reviews.find(review => !review.acknowledged) || null;
  const pendingReview = rawPendingReview ? {
    ...rawPendingReview,
    lineup: rawPendingReview.lineup.map(row => ({
      ...row,
      card: allDecoratedCards.find(card => Number(card.id) === Number(row.cardId)) || null
    }))
  } : null;
  const currentScores = new Map();
  for (const row of getAllCardsLineupsForWeek(week)) {
    currentScores.set(Number(row.user_id), (currentScores.get(Number(row.user_id)) || 0) + Number(row.fp || 0));
  }
  const users = getUserSummaries();
  const weeklyLeaderboard = users.map(user => ({
    display_name: user.display_name,
    fp: currentScores.get(Number(user.id)) || 0
  })).sort((a, b) => b.fp - a.fp || a.display_name.localeCompare(b.display_name));
  const reviewedSeasonByUser = new Map(getCardsLeaderboard().map(row => [Number(row.user_id), Number(row.fp || 0)]));
  const seasonLeaderboard = users.map(user => ({
    display_name: user.display_name,
    fp: (reviewedSeasonByUser.get(Number(user.id)) || 0) + (currentScores.get(Number(user.id)) || 0)
  })).sort((a, b) => b.fp - a.fp || a.display_name.localeCompare(b.display_name));

  return {
    week,
    balance: getUserById(userId)?.balance || 0,
    catalog,
    cards: decoratedCards,
    boosts: refreshedOwned.boosts,
    lineup: decoratedLineup,
    pendingReview,
    weeklyLeaderboard,
    seasonLeaderboard,
    collectionCounts: {
      cards: decoratedCards.length,
      boosts: refreshedOwned.boosts.filter(boost => !boost.consumed).length
    },
    collectionProgress: ['S1', 'S2', 'S3'].map(edition => {
      const eligible = catalog.filter(player => player.edition === edition && player.cardType !== 'mythic');
      const ownedKeys = new Set(allDecoratedCards
        .filter(card => card.player.edition === edition && card.player.cardType !== 'mythic')
        .map(card => card.player.catalogKey));
      return { label: `Season ${edition.replace('S', '')}`, owned: ownedKeys.size, total: eligible.length };
    })
  };
}

async function finalizeCardsForWeek(week, nextWeek) {
  const settings = getAdminSettings();
  const catalog = await getCardsCatalog();
  const catalogByKey = cardsCatalogMap(catalog);
  const rows = getAllCardsLineupsForWeek(week);
  const results = [];

  for (const row of rows) {
    if (!row.card_id) continue;
    const owned = getCardsOwnedState(row.user_id);
    const card = owned.cards.find(item => Number(item.id) === Number(row.card_id));
    const decoratedCard = card ? decorateOwnedCard(card, catalogByKey) : null;
    const player = decoratedCard?.player;
    const boost = owned.boosts.find(item => Number(item.id) === Number(row.boost_id)) || null;
    const userLineup = rows.filter(item => Number(item.user_id) === Number(row.user_id));
    let result = {
      userId: row.user_id,
      slot: row.slot,
      gamesPlayed: 0,
      fp: 0,
      stats: {},
      warning: row.selected_series_key ? 'No confirmed appearance.' : 'No series selected.'
    };
    if (decoratedCard && player) {
      if (decoratedCard.edition === 'S3') {
        if (!row.selected_series_key) {
          results.push(result);
          continue;
        }
        const options = await getCardSeriesOptions({
          seasonId: settings.seasonId,
          week,
          divisionId: player.divisionId,
          teamId: player.teamId
        });
        const selected = options.find(option => option.seriesKey === row.selected_series_key);
        if (selected?.voided) {
          result.warning = 'Series postponed or voided. Card and boost preserved.';
        } else {
          const rawScore = await scoreOwnedCardLineup({ settings, week, row, card: decoratedCard, boost });
          const score = applyChemistryBonus(rawScore, chemistryBonusForCard({
            lineup: userLineup,
            ownedCards: owned.cards,
            catalogByKey,
            card: decoratedCard
          }));
          result = {
            ...result,
            ...score,
            sampleMatchIds: score.sampleMatchIds || [],
            syntheticGames: score.syntheticGames || [],
            scoreBreakdown: score.breakdown || [],
            warning: score.gamesPlayed ? '' : result.warning
          };
          if (score.gamesPlayed > 0) {
            resolveCardsLineupResult({
              userId: row.user_id,
              week,
              slot: row.slot,
              seriesComplete: true,
              ...score,
              sampleMatchIds: score.sampleMatchIds || [],
              syntheticGames: score.syntheticGames || [],
              scoreBreakdown: score.breakdown || []
            });
          }
        }
      } else {
        const rawScore = await scoreOwnedCardLineup({ settings, week, row, card: decoratedCard, boost });
        const score = applyChemistryBonus(rawScore, chemistryBonusForCard({
          lineup: userLineup,
          ownedCards: owned.cards,
          catalogByKey,
          card: decoratedCard
        }));
        result = {
          ...result,
          ...score,
          sampleMatchIds: score.sampleMatchIds || [],
          syntheticGames: score.syntheticGames || [],
          scoreBreakdown: score.breakdown || [],
          warning: score.gamesPlayed ? '' : score.warning || result.warning
        };
        if (score.gamesPlayed > 0) {
          resolveCardsLineupResult({
            userId: row.user_id,
            week,
            slot: row.slot,
            seriesComplete: true,
            ...score,
            sampleMatchIds: score.sampleMatchIds || [],
            syntheticGames: score.syntheticGames || [],
            scoreBreakdown: score.breakdown || []
          });
        }
      }
    }
    results.push(result);
  }
  for (const userId of [...new Set(rows.map(row => Number(row.user_id)).filter(Number.isFinite))]) {
    await refreshResolvedChemistryForUserWeek(userId, week, catalog);
  }
  const calculatedTiers = Object.fromEntries(catalog.map(player => [player.catalogKey, {
    tier: player.tier,
    position: player.position,
    weightedFpPerGame: player.weightedFpPerGame,
    expectedWutFpPerMatch: Number(player.expectedWutFpPerMatch || 0),
    rarityGamesPlayed: Number(player.rarityGamesPlayed || 0),
    rarityEligible: Boolean(player.rarityEligible),
    rarityProvisional: Boolean(player.rarityProvisional),
    updatedAt: new Date().toISOString()
  }]));
  return finalizeCardsWeek({ week, nextWeek, results, calculatedTiers });
}

async function refreshCardsAppearancesForWeek(week) {
  const settings = getAdminSettings();
  const catalog = await getCardsCatalog();
  const catalogByKey = cardsCatalogMap(catalog);
  let resolved = 0;
  for (const row of getAllCardsLineupsForWeek(week)) {
    if (!row.card_id || row.resources_resolved) continue;
    const owned = getCardsOwnedState(row.user_id);
    const card = owned.cards.find(item => Number(item.id) === Number(row.card_id));
    const decoratedCard = card ? decorateOwnedCard(card, catalogByKey) : null;
    const player = decoratedCard?.player;
    if (!decoratedCard || !player) continue;
    if (decoratedCard.edition !== 'S3') continue;
    if (decoratedCard.edition === 'S3') {
      if (!row.selected_series_key) continue;
      const options = await getCardSeriesOptions({
        seasonId: settings.seasonId,
        week,
        divisionId: player.divisionId,
        teamId: player.teamId
      });
      if (options.find(option => option.seriesKey === row.selected_series_key)?.voided) continue;
    }
    const boost = owned.boosts.find(item => Number(item.id) === Number(row.boost_id)) || null;
    const rawScore = await scoreOwnedCardLineup({ settings, week, row, card: decoratedCard, boost });
    const userLineup = getAllCardsLineupsForWeek(week).filter(item => Number(item.user_id) === Number(row.user_id));
    const score = applyChemistryBonus(rawScore, chemistryBonusForCard({
      lineup: userLineup,
      ownedCards: owned.cards,
      catalogByKey,
      card: decoratedCard
    }));
    if (score.gamesPlayed > 0) {
      resolveCardsLineupResult({
        userId: row.user_id,
        week,
        slot: row.slot,
        ...score,
        sampleMatchIds: score.sampleMatchIds || [],
        syntheticGames: score.syntheticGames || [],
        scoreBreakdown: score.breakdown || []
      });
      resolved += 1;
    }
  }
  return resolved;
}

function arenaCatalogByIdentity(catalog) {
  const out = {};
  for (const player of catalog || []) {
    out[player.catalogKey] = player;
    out[player.cardIdentity] = player;
    out[`${player.edition || 'S3'}|${player.divisionId}|${player.playerKey}`] = player;
    out[`${player.divisionId}|${player.playerKey}`] = player;
  }
  return out;
}

function arenaSnapshotForCard(card, wutConfig) {
    if (!card?.player) throw new Error('A saved deck references a card that is no longer in the WUT catalog.');
    const player = card.player;
    const season = player.cardType === 'mythic' ? player.sourceSeason : player.edition;
    return {
      card_id: Number(card.id), card_identity: card.card_identity, position: player.position,
      rarity: player.tier, team_id: player.teamId || '', team_name: player.teamName || player.teamId || '',
      season: season || '', chemistry_key: `${season || ''}|${player.teamId || ''}`,
      display_name: player.name || player.displayName || '',
      base_power: calculateWutPower(player.tier, null, wutConfig),
      power: Number(card.power || calculateWutPower(player.tier, card.trinket?.rarity, wutConfig)),
      trinket: card.trinket ? JSON.parse(JSON.stringify(card.trinket)) : null
    };
}

function arenaDeckSnapshotFromHub(hub, deck) {
  const cards = new Map((hub.cards || []).map(card => [Number(card.id), card]));
  return {
    active: (deck.active_card_ids || []).map(id => arenaSnapshotForCard(cards.get(Number(id)), hub.wut?.config)),
    bench: (deck.bench_card_ids || []).map(id => arenaSnapshotForCard(cards.get(Number(id)), hub.wut?.config))
  };
}

async function scorePendingArenaMatches(catalog = null) {
  const activeCatalog = catalog || await getCardsCatalog();
  const catalogByKey = cardsCatalogMap(activeCatalog);
  const globalConfig = await getLiveCardsConfig();
  let resolved = 0;
  const scoringMatches = postgresEnabled
    ? [...await getArenaMatchesNeedingScoringPostgres(postgresPool()), ...await getDraftMatchesNeedingScoringPostgres(postgresPool()), ...await getWutDebugMatchesNeedingScoringPostgres(postgresPool())]
    : getArenaMatchesNeedingScoring();
  for (const match of scoringMatches) {
    const draftEvent = match.draft_event_id
      ? (postgresEnabled
        ? (await getDraftEventLobbyPostgres(postgresPool(), { eventId: match.draft_event_id, includePrivate: true }))[0]
        : getWutDraftEventLobby({ eventId: match.draft_event_id, includePrivate: true })[0])
      : null;
    const frozenRules = draftEvent?.environment_snapshot?.rules || match.rules_snapshot || {};
    const config = draftEvent ? {
      ...globalConfig,
      scoring: frozenRules.scoring || globalConfig.scoring,
      boostEffects: frozenRules.boostEffects || globalConfig.boostEffects,
      wut: { ...globalConfig.wut, trinketEffects: frozenRules.trinketEffects || globalConfig.wut.trinketEffects }
    } : globalConfig;
    let rawScores = [];
    for (const placement of match.placements) {
      const eventInventory = draftEvent?.inventories?.[String(placement.owner_user_id || placement.user_id)] || null;
      const owned = eventInventory ? null : (postgresEnabled
        ? await getCardsOwnedStatePostgres(postgresPool(), placement.owner_user_id || placement.user_id)
        : getCardsOwnedState(placement.owner_user_id || placement.user_id));
      const rawCard = (eventInventory?.cards || owned?.cards || []).find(card => Number(card.id) === Number(placement.card_id));
      const card = rawCard ? (eventInventory ? draftEventCardView(rawCard, eventInventory, catalogByKey) : decorateOwnedCard(rawCard, catalogByKey)) : null;
      const rawBoost = (eventInventory?.boosts || owned?.boosts || []).find(boost => Number(boost.id) === Number(placement.boost_id)) || null;
      const boost = rawBoost ? {
        ...rawBoost,
        effect: config.boostEffects?.[rawBoost.boost_type]?.[rawBoost.rarity] || rawBoost.effect || DEFAULT_BOOST_EFFECTS[rawBoost.boost_type]?.[rawBoost.rarity]
      } : null;
      const snapshotTrinket = placement.card_snapshot?.trinket || null;
      const legalTrinket = trinketFitsWutPosition(snapshotTrinket?.family, card?.player?.position || placement.card_snapshot?.position) ? snapshotTrinket : null;
      if (!card?.player?.position) {
        rawScores.push({ placement, card: null, boost: null, trinket: legalTrinket, logs: [], result: { fp: 0, exactFp: 0, gamesPlayed: 0, stats: {}, sampleMatchIds: [], syntheticGames: [], breakdown: [], gameFps: [] } });
        continue;
      }
      const result = await scoreHistoricalCardSample({
        player: card.player,
        position: card.player.position,
        boost: Number(match.rules_version || 1) >= 2 ? null : boost,
        scoringConfig: config.scoring
      });
      rawScores.push({ placement, card, boost, result, trinket: legalTrinket, logs: snapshotTrinket && !legalTrinket ? ['Illegal position trinket ignored.'] : [] });
    }
    rawScores = resolveZebraStripes(rawScores.map(entry => ({
      ...entry,
      userId: Number(entry.placement.user_id),
      slot: entry.placement.slot,
      printedChemistryKey: entry.placement.card_snapshot?.chemistry_key || wutChemistryKey(entry.card?.player)
    })), config.wut.trinketEffects);
    for (const entry of rawScores) entry.chemistryKey = entry.printedChemistryKey;
    for (const entry of rawScores.filter(item => item.trinket?.family === 'journeyman')) {
      const locked = String(entry.placement.journeyman_key || '');
      const seedText = `${match.id}|${entry.userId}|${entry.slot}|journeyman`;
      let hash = 2166136261;
      for (const char of seedText) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      const deterministicRandom = () => (hash >>> 0) / 4294967296;
      entry.chemistryKey = resolveJourneymanIdentity(entry, rawScores, locked, deterministicRandom);
    }
    const rawBoostGains = new Map(rawScores.map(entry => [entry, boostFantasyBonus(entry.result.stats, entry.boost)]));
    const positive = [];
    for (const entry of rawScores) {
      const chemistryKey = entry.chemistryKey;
      const crossSideJourneyman = entry.trinket?.family === 'journeyman' && entry.trinket.effect?.crossSide;
      const chemistryGroup = chemistryKey
        ? rawScores.filter(other =>
          (crossSideJourneyman || Number(other.placement.user_id) === Number(entry.placement.user_id)) &&
          other.chemistryKey === chemistryKey
        )
        : [];
      const teamCount = chemistryGroup.length;
      const captainPatch = chemistryGroup
        .filter(other => Number(other.placement.user_id) === Number(entry.placement.user_id) && other.trinket?.family === 'team_crest')
        .sort((a, b) => Number(b.trinket?.effect || 0) - Number(a.trinket?.effect || 0))[0] || null;
      const baseChemistryMultiplier = chemistryMultiplierForCount(teamCount, config.scoring);
      const captainChemistry = captainPatchChemistry(baseChemistryMultiplier, captainPatch ? [captainPatch.trinket.effect] : []);
      if (Number(match.rules_version || 1) < 2) {
        const result = applyChemistryBonus(entry.result, { count: teamCount, multiplier: chemistryMultiplierForCount(teamCount, config.scoring) });
        positive.push({ ...entry, teamCount, wouldBeFp: Number(result.exactFp || result.fp || 0), finalFp: Number(result.exactFp || result.fp || 0), result });
        continue;
      }
      if (!entry.card) { positive.push({ ...entry, teamCount, wouldBeFp: 0, finalFp: 0 }); continue; }
      const opponent = rawScores.find(other => Number(other.placement.user_id) !== Number(entry.placement.user_id) && other.placement.slot === entry.placement.slot);
      const first = !opponent || new Date(entry.placement.committed_at) < new Date(opponent.placement.committed_at);
      let bonusGameFps = [];
      let bonusRolledGames = [];
      if (entry.trinket?.family === 'lucky_charm' && (entry.result.gameFps || []).length) {
        const bonus = await scoreHistoricalCardSample({
          player: entry.card.player,
          position: entry.card.player.position,
          boost: null,
          excludeMatchIds: entry.result.sampleMatchIds || [],
          scoringConfig: config.scoring
        });
        bonusGameFps = bonus.gameFps || [];
        bonusRolledGames = bonus.rolledGames || bonus.syntheticGames || [];
      }
      const positiveLayers = applyWutPositiveScoring({
        baseExactFp: Number(entry.result.exactFp || entry.result.fp || 0), trinket: entry.trinket,
        gameFps: entry.result.gameFps || [], bonusGameFps, breakdown: entry.result.breakdown || [],
        isFirst: first, hasOpponent: Boolean(opponent), teamCount,
        cardRarityRank: entry.placement.card_snapshot?.base_power || CARD_STARS[entry.placement.card_snapshot?.rarity] || 1,
        opponentRarityRank: opponent?.placement?.card_snapshot?.base_power || CARD_STARS[opponent?.placement?.card_snapshot?.rarity] || null,
        stats: entry.result.stats, boost: entry.boost, boostLoad: entry.placement.boost_load,
        adjacentBoostGains: rawScores.filter(other => Number(other.userId) === Number(entry.userId) && adjacentWutSlots(entry.slot).includes(other.slot)).map(other => rawBoostGains.get(other)),
        chemistryMultiplier: captainChemistry.multiplier
      });
      entry.logs.push(...positiveLayers.logs);
      const scoringEffects = [];
      if (entry.trinket?.family === 'lucky_charm' || Number(positiveLayers.trinketGain || 0)) {
        scoringEffects.push({
          type: 'trinket',
          family: entry.trinket?.family || '',
          direction: Number(positiveLayers.trinketGain || 0) < 0 ? 'self-negative' : 'self',
          triggered: entry.trinket?.family === 'lucky_charm' ? Boolean(positiveLayers.luckyCharm?.hit) : Number(positiveLayers.trinketGain || 0) !== 0,
          label: positiveLayers.trinketLabel || 'Trinket',
          points: Number(positiveLayers.trinketGain || 0),
          rarity: entry.trinket?.rarity || 'common'
        });
      }
      if (positiveLayers.boostGain) scoringEffects.push({
        type: 'boost',
        label: `${String(entry.boost?.rarity || '').replace(/\b\w/g, char => char.toUpperCase())} ${String(entry.boost?.boost_type || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())} Boost`,
        points: positiveLayers.boostGain,
        rarity: entry.boost?.rarity || 'common'
      });
      const preChemistryFp = Number(positiveLayers.preChemistryFp || 0);
      const baseChemistryGain = preChemistryFp * Math.max(0, baseChemistryMultiplier - 1);
      const captainPatchGain = Math.max(0, Number(positiveLayers.chemistryGain || 0) - baseChemistryGain);
      if (baseChemistryGain) scoringEffects.push({
        type: 'chemistry',
        label: `Chemistry (+${Number(((baseChemistryMultiplier - 1) * 100).toFixed(2))}%)`,
        points: baseChemistryGain
      });
      if (captainPatchGain) scoringEffects.push({
        type: 'trinket',
        family: 'team_crest',
        triggered: true,
        label: `Captain's Patch (+${Number(captainChemistry.effect * 100).toFixed(0)}% chemistry)`,
        points: captainPatchGain,
        rarity: captainPatch?.trinket?.rarity || 'common'
      });
      if (entry.zebraReduction) scoringEffects.push({
        type: 'trinket',
        family: 'zebra_stripes',
        direction: 'incoming',
        triggered: true,
        label: entry.trinket
          ? `Zebra Stripes downgraded ${entry.originalTrinket?.rarity} to ${entry.trinket.rarity}`
          : `Zebra Stripes nullified ${entry.originalTrinket?.rarity || ''} trinket`,
        points: 0,
        rarity: entry.zebraRarity || 'common'
      });
      if (entry.trinket?.family === 'zebra_stripes' && rawScores.some(other =>
        Number(other.userId) !== Number(entry.userId) && other.slot === entry.slot && Number(other.zebraReduction || 0) > 0
      )) scoringEffects.push({
        type: 'trinket', family: 'zebra_stripes', direction: 'outgoing', triggered: true,
        label: 'Zebra Stripes triggered', points: 0, rarity: entry.trinket.rarity || 'common'
      });
      positive.push({
        ...entry,
        teamCount,
        wouldBeFp: positiveLayers.wouldBeFp,
        finalFp: positiveLayers.wouldBeFp,
        scoringEffects,
        luckyCharm: positiveLayers.luckyCharm,
        bonusGameFps,
        bonusRolledGames
      });
    }
    const interacted = resolveWutMatchingTrinkets(positive);
    const scored = interacted.map(entry => {
      const result = entry.result;
      return {
        ...entry.placement,
        fp: Math.round(Math.max(0, entry.finalFp)),
        exact_fp: Math.max(0, Number(entry.finalFp || 0)),
        would_be_fp: Number(entry.wouldBeFp || 0),
        games_played: Number(result.gamesPlayed || 0),
        stats: result.stats || {},
        sample_match_ids: result.sampleMatchIds || [],
        synthetic_games: result.syntheticGames || [],
        rolled_games: result.rolledGames || result.syntheticGames || [],
        rolled_game_fps: result.gameFps || [],
        bonus_rolled_games: entry.bonusRolledGames || [],
        bonus_game_fps: entry.bonusGameFps || [],
        lucky_charm: entry.luckyCharm || null,
        reveal_data_version: 8,
        score_breakdown: result.breakdown || [],
        scoring_effects: entry.scoringEffects || [],
        journeyman_key_effective: entry.trinket?.family === 'journeyman' && entry.chemistryKey !== entry.printedChemistryKey ? entry.chemistryKey : '',
        card_rarity: entry.card?.player?.tier || 'common',
        power: Number(entry.placement.power || 1), trinket: entry.trinket,
        effect_log: entry.logs
      };
    });
    if (postgresEnabled && match.debug) await completeWutDebugMatchPostgres(postgresPool(), { adminUserId: match.admin_user_id, scoredPlacements: scored });
    else if (postgresEnabled && match.draft_event_id) await completeWutDraftEventMatchPostgres(postgresPool(), { eventId: match.draft_event_id, matchId: match.id, scoredPlacements: scored });
    else if (postgresEnabled) await completeArenaMatchPostgres(postgresPool(), { matchId: match.id, scoredPlacements: scored });
    else completeArenaMatch(match.arena_match_key || match.id, scored);
    resolved += 1;
  }
  if (!postgresEnabled) await awardCompletedWutDraftEvents(activeCatalog);
  return resolved;
}

async function processAutomaticWutDraftStarts(catalog = null, now = new Date()) {
  processWutDraftEvents(now);
  const due = getWutDraftEventLobby({ includePrivate: true }).filter(event =>
    event.phase === 'signup_closed' && event.config.basic.automaticStart && event.config.scheduling.startsAt &&
    now.getTime() >= new Date(event.config.scheduling.startsAt).getTime() &&
    event.active_entrant_count >= Number(event.config.basic.minimumEntrants)
  );
  if (!due.length) return [];
  const activeCatalog = catalog || await getCardsCatalog();
  const started = [];
  for (const event of due) {
    startWutDraftEvent({ eventId: event.id, environment: await draftEnvironmentFromCatalog(event, activeCatalog), adminUserId: null, system: true, now });
    beginWutDraftSafetyBench({ eventId: event.id, adminUserId: null, system: true, now });
    started.push(Number(event.id));
  }
  return started;
}

async function awardCompletedWutDraftEvents(catalog = null, eventId = null, adminUserId = null) {
  const activeCatalog = catalog || await getCardsCatalog();
  const config = await getLiveCardsConfig();
  const completed = getWutDraftEventLobby({ includePrivate: true }).filter(event => event.phase === 'complete' && !event.prizes?.awarded_at && (eventId == null || Number(event.id) === Number(eventId)));
  const results = [];
  for (const event of completed) results.push(awardWutDraftEventPrizes({
    eventId: event.id, adminUserId,
    generatePack: packType => generateWutPlayerPack({ packType, catalog: activeCatalog, config })
  }));
  return results;
}

async function processArena(now = new Date()) {
  if (arenaClockBusy) return;
  arenaClockBusy = true;
  try {
    if (postgresEnabled) {
      const settings = await getAdminSettingsPostgres(postgresPool());
      if (settings.maintenanceMode) return null;
      const catalog = await getCardsCatalog();
      if (!settings.cardsOpen) return catalog;
      const arenaMeta = (await postgresPool().query("SELECT data FROM app_documents WHERE document_key='arena_meta'")).rows[0]?.data || {};
      const slot = String(Math.floor(now.getTime() / (30 * 60 * 1000)));
      if (String(arenaMeta.lastMatchmakingSlot || '') !== slot) await assignArenaMatchupsPostgres(postgresPool(), { now });
      await autoAssignExpiredArenaTurnsPostgres(postgresPool(), { now });
      await scorePendingArenaMatches(catalog);
      const draftTick = await processWutDraftEventsPostgres(postgresPool(), now);
      for (const eventId of draftTick.startDueEventIds) {
        const current = (await getDraftEventLobbyPostgres(postgresPool(), { eventId, includePrivate: true }))[0];
        if (!current || current.phase !== 'signup_closed') continue;
        await startWutDraftEventPostgres(postgresPool(), {
          eventId,
          environment: await draftEnvironmentFromCatalog(current, catalog),
          system: true,
          now
        });
        await beginWutDraftSafetyBenchPostgres(postgresPool(), { eventId, system: true, now });
      }
      return catalog;
    }
    if (getAdminSettings().maintenanceMode) return null;
    if (!getAdminSettings().cardsOpen) return getCardsCatalog();
    const admin = getArenaAdminState(now);
    if (admin.matchmakingDue) {
      assignArenaMatchups(now);
    }
    const catalog = await getCardsCatalog();
    const identityMap = arenaCatalogByIdentity(catalog);
    autoAssignExpiredArenaTurns(identityMap, now);
    await scorePendingArenaMatches(catalog);
    await processAutomaticWutDraftStarts(catalog, now);
    return catalog;
  } finally {
    arenaClockBusy = false;
  }
}

function decorateArenaMatch(match, allCards, boosts) {
  const placements = (match.placements || []).map(row => {
    const currentCard = allCards.find(item => Number(item.id) === Number(row.card_id)) || null;
    const card = currentCard ? { ...currentCard, power: Number(row.power || currentCard.power || 1), trinket: row.card_snapshot?.trinket || row.trinket || currentCard.trinket || null } : null;
    const boost = boosts.find(item => Number(item.id) === Number(row.boost_id)) || null;
    const needsSavePctBreakdown = card?.player?.position === 'G' && row.stats && !(row.score_breakdown || []).some(item => item.type === 'save_pct');
    return {
      ...row,
      card,
      boost,
      score_breakdown: needsSavePctBreakdown
        ? buildFantasyBreakdown(row.stats, 'G', boost, { unavailableStats: card.player.unavailableStats || [], scoringConfig: liveCardsConfigCache.scoring })
        : row.score_breakdown
    };
  });
  const visualsByChemistry = new Map(placements.map(row => [row.card_snapshot?.chemistry_key, {
    logo: row.card?.player?.teamLogo || '',
    background: row.card?.player?.teamBgColor || '#111520',
    name: row.card_snapshot?.team_name || row.card?.player?.teamName || row.card_snapshot?.team_id || ''
  }]));
  return {
    ...match,
    placements: placements.map(row => {
      const printedKey = String(row.card_snapshot?.chemistry_key || '');
      const adoptedKey = String(row.journeyman_key_effective || row.journeyman_key || '');
      const adopted = adoptedKey && adoptedKey !== printedKey ? visualsByChemistry.get(adoptedKey) : null;
      return adopted?.logo && row.card
        ? { ...row, card: { ...row.card, matchTeamLogo: adopted.logo, matchTeamBgColor: adopted.background, matchTeamName: adopted.name } }
        : row;
    })
  };
}

async function buildArenaCardsHub(userId, query = {}) {
  const catalog = postgresEnabled ? await getCardsCatalog() : await processArena(new Date()) || await getCardsCatalog();
  const catalogByKey = cardsCatalogMap(catalog);
  if (!postgresEnabled) reconcileWutTrinketPositions(userId, arenaCatalogByIdentity(catalog));
  const owned = postgresEnabled
    ? await getCardsOwnedStatePostgres(postgresPool(), userId)
    : getCardsOwnedState(userId);
  const config = await getLiveCardsConfig();
  const membership = postgresEnabled
    ? await getWutMembershipStatePostgres(postgresPool(), userId)
    : getWutMembershipState(userId);
  if (membership.starterOpened) {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    try {
      const opportunities = await buildWutMissionBetOpportunities({
        seasonId: settings.seasonId,
        week: settings.currentWeek
      });
      const locked = postgresEnabled
        ? (settings.lockedWeeks || []).map(Number).includes(Number(settings.currentWeek))
        : isWeekLocked(settings.currentWeek);
      if (postgresEnabled) {
        await setWutMissionBetOpportunitiesPostgres(postgresPool(), {
          week: settings.currentWeek,
          opportunities,
          locked
        });
      } else {
        setWutMissionBetOpportunities({
          week: settings.currentWeek,
          opportunities,
          locked
        });
      }
    } catch (err) {
      console.error('Could not refresh WUT sportsbook mission options:', err);
    }
  }
  const wut = membership.starterOpened
    ? (postgresEnabled ? await getWutSystemsStatePostgres(postgresPool(), userId) : getWutSystemsState(userId))
    : { wutCoins: 0, decks: [], trinkets: [], shop: null, config: liveCardsConfigCache.wut };
  const trinketsById = new Map((wut.trinkets || []).map(item => [Number(item.id), item]));
  const cards = owned.cards.map(card => {
    const decorated = decorateOwnedCard(card, catalogByKey);
    const trinket = trinketsById.get(Number(card.trinket_id)) || null;
    return { ...decorated, trinket, power: calculateWutPower(decorated.player?.tier, trinket?.rarity, wut.config) };
  });
  const boosts = owned.boosts.map(boost => ({
    ...boost,
    effect: config.boostEffects?.[boost.boost_type]?.[boost.rarity] || boost.effect || DEFAULT_BOOST_EFFECTS[boost.boost_type]?.[boost.rarity]
  }));
  const arena = postgresEnabled
    ? await getArenaStateForUserPostgres(postgresPool(), userId)
    : getArenaStateForUser(userId);
  const allMatchCardIds = new Set([
    ...arena.activeMatches, ...arena.readyMatches, ...arena.history
  ].flatMap(match => match.placements.map(row => Number(row.card_id))));
  const missingCards = [];
  for (const matchUserId of [...new Set([...arena.activeMatches, ...arena.readyMatches, ...arena.history].flatMap(match => match.player_ids))]) {
    if (Number(matchUserId) === Number(userId)) continue;
    const matchOwned = postgresEnabled
      ? await getCardsOwnedStatePostgres(postgresPool(), matchUserId)
      : getCardsOwnedState(matchUserId);
    for (const card of matchOwned.cards) {
      if (allMatchCardIds.has(Number(card.id))) missingCards.push(decorateOwnedCard(card, catalogByKey));
    }
  }
  const matchCards = [...cards, ...missingCards];
  const otherBoosts = [];
  for (const matchUserId of [...new Set([...arena.activeMatches, ...arena.readyMatches, ...arena.history].flatMap(match => match.player_ids))]) {
    if (Number(matchUserId) === Number(userId)) continue;
    const matchOwned = postgresEnabled
      ? await getCardsOwnedStatePostgres(postgresPool(), matchUserId)
      : getCardsOwnedState(matchUserId);
    otherBoosts.push(...matchOwned.boosts);
  }
  const matchBoosts = [...boosts, ...otherBoosts];
  arena.activeMatches = arena.activeMatches.map(match => decorateArenaMatch(match, matchCards, matchBoosts));
  arena.readyMatches = arena.readyMatches.map(match => decorateArenaMatch(match, matchCards, matchBoosts));
  arena.history = arena.history.map(match => decorateArenaMatch(match, matchCards, matchBoosts));
  const lockedCardIds = new Set(arena.activeMatches.flatMap(match => match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id))));
  const lockedBoostIds = new Set(arena.activeMatches.flatMap(match => match.placements.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.boost_id))));
  cards.sort((a, b) => (CARD_STARS[b.player?.tier] || 0) - (CARD_STARS[a.player?.tier] || 0) || String(a.player?.name).localeCompare(String(b.player?.name)));
  return {
    arena,
    wutMembership: membership,
    wut,
    cards: cards.map(card => ({ ...card, arenaLocked: false })),
    boosts: boosts.filter(boost => !boost.consumed).map(boost => ({ ...boost, arenaLocked: lockedBoostIds.has(Number(boost.id)) })),
    balance: postgresEnabled ? Number((await getUserByIdPostgres(postgresPool(), userId))?.balance || 0) : getUserById(userId)?.balance || 0,
    wutCoins: Number(wut.wutCoins || 0),
    adminArena: getArenaAdminState(),
    replayMatchId: Number(query.replay || query.reveal || 0) || null,
    revealMatchId: Number(query.reveal || 0) || null,
    cooldowns: CARD_COOLDOWNS,
    collectionProgress: ['S1', 'S2', 'S3'].map(edition => {
      const eligible = catalog.filter(player => player.edition === edition && player.cardType !== 'mythic');
      const ownedKeys = new Set(cards.filter(card => card.player.edition === edition && card.player.cardType !== 'mythic').map(card => card.player.catalogKey));
      return { label: `Season ${edition.replace('S', '')}`, owned: ownedKeys.size, total: eligible.length };
    })
  };
}

const arenaClock = setInterval(() => {
  processArena(new Date()).catch(err => console.error('WUT clock failed:', err));
}, 60000);
arenaClock.unref?.();

app.use('/cards', async (req, res, next) => {
  if (req.method === 'GET' && req.path === '/') return next();
  return requireWutOpen(req, res, next);
});

app.get('/cards', requireLogin, async (req, res, next) => {
  try {
    res.render('cards', await buildArenaCardsHub(req.session.userId, req.query));
  } catch (err) {
    next(err);
  }
});

app.get('/cards/guide', requireLogin, async (req, res, next) => {
  try { res.render('cards_guide', { wutConfig: (await getLiveCardsConfig()).wut }); }
  catch (err) { next(err); }
});

app.get('/cards/drafts', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    if (!postgresEnabled) processWutDraftEvents(new Date());
    const membership = postgresEnabled
      ? await getWutMembershipStatePostgres(postgresPool(), req.session.userId)
      : getWutMembershipState(req.session.userId);
    const user = res.locals.currentUser;
    const draftEvents = postgresEnabled
      ? await getDraftEventLobbyPostgres(postgresPool(), { userId: req.session.userId })
      : getWutDraftEventLobby({ userId: req.session.userId });
    res.render('cards_draft_events', {
      draftEvents: draftEvents.filter(isWutDraftEventLobbyVisible),
      wutCoins: Number(membership.wutCoins || 0),
      mushybux: Number(user?.balance || 0)
    });
  } catch (err) {
    next(err);
  }
});

function draftEventCardView(item, inventory = null, catalogByKey = null) {
  const snapshot = item.player_snapshot || item.card || item;
  const catalogPlayer = catalogByKey?.get(snapshot.cardIdentity || snapshot.catalogKey) || null;
  const player = hydrateWutDraftCardPlayer(snapshot, catalogPlayer);
  const trinket = item.trinket || (item.trinket_id == null ? null : inventory?.trinkets?.find(row => Number(row.id) === Number(item.trinket_id))) || null;
  return {
    id: Number(item.id || 0), eventItemId: item.id || null,
    card_identity: snapshot.cardIdentity,
    power: Number(item.power || CARD_STARS[snapshot.tier] || 1),
    player: {
      ...player,
      cardArt: snapshot.cardArt || snapshot.card_art || snapshot.edition || 'S3',
      card_type: snapshot.cardType || snapshot.card_type || 'player',
      stars: snapshot.stars || CARD_STARS[snapshot.tier] || 1
    },
    trinket,
    fantasyAppearances: { appearances: 0, gamesPlayed: 0, fp: 0, stats: {} },
    wutMatchStats: { matchesPlayed: 0, fp: 0, fpPerMatch: 0 }
  };
}

async function postgresDraftMatchPayload(eventId, matchId, userId) {
  const event = (await getDraftEventLobbyPostgres(postgresPool(), { eventId, userId, includePrivate: true }))[0];
  if (!event) throw new Error('Draft Event not found.');
  const raw = (event.tournament?.matches || []).find(item => String(item.id) === String(matchId));
  if (!raw || !(raw.player_ids || []).map(Number).includes(Number(userId))) throw new Error('Draft Event match not found.');
  const first = Number(raw.first_player_id);
  const second = Number(raw.player_ids.find(id => Number(id) !== first));
  const current = raw.status === 'active' ? (Number(raw.turn_index || 0) % 2 === 0 ? first : second) : null;
  const players = raw.player_ids.map(id => {
    const entrant = event.entrants.find(item => Number(item.user_id) === Number(id));
    return { id: Number(id), displayName: entrant?.display_name || `Player ${id}` };
  });
  const match = { ...raw, players, opponent: players.find(player => player.id !== Number(userId)) || null,
    current_player_id: current, cards_required_this_turn: raw.status === 'active' ? [1, 2, 2, 2, 2, 1][Number(raw.turn_index)] : 0,
    is_your_turn: current === Number(userId), timer_paused: Boolean(event.paused_at),
    boost_load_used: (raw.placements || []).filter(row => Number(row.user_id) === Number(userId)).reduce((sum, row) => sum + Number(row.boost_load || 0), 0) };
  return { event, match };
}

app.get('/cards/drafts/:eventId', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    if (!postgresEnabled) processWutDraftEvents(new Date());
    const event = (postgresEnabled
      ? await getDraftEventLobbyPostgres(postgresPool(), { eventId: req.params.eventId, userId: req.session.userId })
      : getWutDraftEventLobby({ eventId: req.params.eventId, userId: req.session.userId }))[0];
    if (!event) return res.status(404).send('Draft Event not found.');
    const inventorySource = Object.keys(event.inventories || {}).length ? event.inventories : event.archived_inventories || {};
    const inventory = inventorySource[String(req.session.userId)] || { cards: [], boosts: [], trinkets: [], safety_bench_card_ids: [] };
    const vote = event.bench?.votes?.find(item => Number(item.user_id) === Number(req.session.userId)) || null;
    const currentPack = event.phase === 'draft' ? event.draft.boosters.find(pack =>
      Number(pack.booster_number) === Number(event.draft.current_booster) &&
      Number(pack.current_owner_user_id) === Number(req.session.userId) && !pack.awaiting_pass && pack.items.length
    ) : null;
    res.render('cards_draft_event', {
      event,
      inventory: {
        ...inventory,
        cardViews: (inventory.cards || []).map(item => draftEventCardView(item, inventory)),
        boostViews: inventory.boosts || [],
        trinketViews: inventory.trinkets || []
      },
      benchCandidates: (event.bench?.candidates || []).map(candidate => ({ ...candidate, cardView: draftEventCardView(candidate) })),
      benchWinners: (event.bench?.winners || []).map(winner => ({ ...winner, cardView: draftEventCardView(winner) })),
      userVote: vote,
      eventDeck: event.decks?.[String(req.session.userId)] || null,
      isEntrant: event.joined_by_user,
      currentPack: currentPack ? {
        ...currentPack,
        itemViews: currentPack.items.map(item => item.item_type === 'player' ? { ...item, cardView: draftEventCardView(item) } : item)
      } : null,
      waitingForDraftPass: event.phase === 'draft' && !event.draft.pending_user_ids.map(Number).includes(Number(req.session.userId))
    });
  } catch (err) {
    next(err);
  }
});

app.get('/cards/drafts/:eventId/status', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    if (!postgresEnabled) processWutDraftEvents(new Date());
    const event = (postgresEnabled
      ? await getDraftEventLobbyPostgres(postgresPool(), { eventId: req.params.eventId, userId: req.session.userId })
      : getWutDraftEventLobby({ eventId: req.params.eventId, userId: req.session.userId }))[0];
    if (!event) return res.status(404).json({ error: 'Draft Event not found.' });
    const currentPack = event.phase === 'draft' ? event.draft.boosters.find(pack =>
      Number(pack.booster_number) === Number(event.draft.current_booster) &&
      Number(pack.current_owner_user_id) === Number(req.session.userId) && !pack.awaiting_pass && pack.items.length
    ) : null;
    res.json({
      phase: event.phase,
      paused: Boolean(event.paused_at),
      draft: event.phase === 'draft' ? {
        booster: Number(event.draft.current_booster || 0),
        pick: Number(event.draft.current_pick || 0),
        pendingCount: event.draft.pending_user_ids.length,
        isPending: event.draft.pending_user_ids.map(Number).includes(Number(req.session.userId)),
        deadlineAt: event.draft.deadline_at || null,
        packId: currentPack ? Number(currentPack.id) : null,
        packItemCount: currentPack?.items?.length || 0
      } : null
    });
  } catch (err) { next(err); }
});

app.post('/cards/drafts/:eventId/bench-vote', requireLogin, requireWutReady, async (req, res) => {
  try {
    const values = key => req.body[key] == null ? [] : Array.isArray(req.body[key]) ? req.body[key] : [req.body[key]];
    const input = {
      eventId: req.params.eventId, userId: req.session.userId,
      selections: { F: values('F'), D: values('D'), G: values('G') }
    };
    if (postgresEnabled) await voteWutDraftSafetyBenchPostgres(postgresPool(), input);
    else voteWutDraftSafetyBench(input);
    req.session.flash = { type: 'success', message: 'Your shared Safety Bench vote was saved.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/cards/drafts/${req.params.eventId}`);
});

app.post('/cards/drafts/:eventId/pick', requireLogin, requireWutReady, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, userId: req.session.userId, itemId: req.body.item_id };
    const result = postgresEnabled ? await pickWutDraftItemPostgres(postgresPool(), input) : pickWutDraftItem(input);
    const item = result.pick.item;
    const label = item.item_type === 'player' ? item.player_snapshot?.displayName : item.item_type === 'boost' ? `${item.rarity} ${item.boost_type} boost` : `${item.rarity} ${wutTrinketName(item.family)}`;
    req.session.flash = { type: 'success', message: `${label || 'Item'} drafted.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/cards/drafts/${req.params.eventId}`);
});

app.post('/cards/drafts/:eventId/deck', requireLogin, requireWutReady, async (req, res) => {
  try {
    const values = req.body.active_card_ids == null ? [] : Array.isArray(req.body.active_card_ids) ? req.body.active_card_ids : [req.body.active_card_ids];
    const input = { eventId: req.params.eventId, userId: req.session.userId, activeCardIds: values };
    const result = postgresEnabled ? await saveWutDraftEventDeckPostgres(postgresPool(), input) : saveWutDraftEventDeck(input);
    req.session.flash = { type: 'success', message: result.event.phase === 'tournament' ? 'Event Deck saved for the next tournament round.' : result.event.phase === 'complete' ? 'Event Deck locked. The tournament is complete.' : 'Event Deck saved. You can revise it until deckbuilding closes.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/cards/drafts/${req.params.eventId}`);
});

app.post('/cards/drafts/:eventId/trinkets/attach', requireLogin, requireWutReady, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, userId: req.session.userId, cardId: req.body.card_id, trinketId: req.body.trinket_id };
    if (postgresEnabled) await attachWutDraftEventTrinketPostgres(postgresPool(), input);
    else attachWutDraftEventTrinket(input);
    req.session.flash = { type: 'success', message: 'Temporary trinket attached for this event.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/cards/drafts/${req.params.eventId}`);
});

app.post('/cards/drafts/:eventId/trinkets/detach', requireLogin, requireWutReady, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, userId: req.session.userId, cardId: req.body.card_id };
    if (postgresEnabled) await detachWutDraftEventTrinketPostgres(postgresPool(), input);
    else detachWutDraftEventTrinket(input);
    req.session.flash = { type: 'success', message: 'Temporary trinket detached.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/cards/drafts/${req.params.eventId}`);
});

app.get('/cards/drafts/:eventId/matches/:matchId', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    if (!postgresEnabled) processWutDraftEvents(new Date());
    const payload = postgresEnabled
      ? await postgresDraftMatchPayload(req.params.eventId, req.params.matchId, req.session.userId)
      : getWutDraftEventMatch({ eventId: req.params.eventId, matchId: req.params.matchId, userId: req.session.userId });
    const { event } = payload; let { match } = payload;
    const allCards = []; const allBoosts = [];
    const inventorySource = Object.keys(event.inventories || {}).length ? event.inventories : event.archived_inventories || {};
    for (const inventory of Object.values(inventorySource)) {
      allCards.push(...(inventory.cards || []).map(item => draftEventCardView(item, inventory)));
      allBoosts.push(...(inventory.boosts || []).map(boost => ({ ...boost, effect: event.environment_snapshot?.rules?.boostEffects?.[boost.boost_type]?.[boost.rarity] || boost.effect })));
    }
    match = decorateArenaMatch(match, allCards, allBoosts);
    const inventory = inventorySource[String(req.session.userId)] || { cards: [], boosts: [], trinkets: [] };
    const snapshotIds = new Set([...(match.deck_snapshots?.[String(req.session.userId)]?.active || []), ...(match.deck_snapshots?.[String(req.session.userId)]?.bench || [])].map(card => Number(card.card_id)));
    const snapshots = new Map([...(match.deck_snapshots?.[String(req.session.userId)]?.active || []), ...(match.deck_snapshots?.[String(req.session.userId)]?.bench || [])].map(card => [Number(card.card_id), card]));
    let cards = (inventory.cards || []).filter(card => snapshotIds.has(Number(card.id))).map(card => ({ ...draftEventCardView(card, inventory), power: snapshots.get(Number(card.id))?.power, trinket: snapshots.get(Number(card.id))?.trinket || null }));
    cards = availableWutMatchCards(cards, match.placements, req.session.userId);
    const usedThisMatch = new Set(match.placements.map(row => Number(row.boost_id)).filter(Boolean));
    const boosts = (inventory.boosts || []).filter(boost => event.config.match.boostsMode === 'refresh_each_match' ? !usedThisMatch.has(Number(boost.id)) : !boost.consumed).map(boost => ({
      ...boost, arenaLocked: false, effect: event.environment_snapshot?.rules?.boostEffects?.[boost.boost_type]?.[boost.rarity] || boost.effect
    }));
    res.render('cards_match', {
      match, cards, boosts, arena: { rating: getArenaStateForUser(req.session.userId).rating },
      wut: { config: { ...(await getLiveCardsConfig()).wut, ...(event.environment_snapshot?.rules || {}), boostLoadCap: event.config.match.boostLoadCap } },
      eventContext: { id: event.id, name: event.config.basic.name }
    });
  } catch (err) { next(err); }
});

app.get('/cards/drafts/:eventId/matches/:matchId/results', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    const payload = postgresEnabled
      ? await postgresDraftMatchPayload(req.params.eventId, req.params.matchId, req.session.userId)
      : getWutDraftEventMatch({ eventId: req.params.eventId, matchId: req.params.matchId, userId: req.session.userId });
    const { event } = payload; let { match } = payload;
    if (!['ready', 'completed'].includes(match.status) || !(match.revealed_by || []).map(Number).includes(Number(req.session.userId))) return res.redirect(`/cards/drafts/${event.id}/matches/${match.id}`);
    const allCards = []; const allBoosts = [];
    const inventorySource = Object.keys(event.inventories || {}).length ? event.inventories : event.archived_inventories || {};
    for (const inventory of Object.values(inventorySource)) {
      allCards.push(...(inventory.cards || []).map(item => draftEventCardView(item, inventory)));
      allBoosts.push(...(inventory.boosts || []).map(boost => ({ ...boost, effect: event.environment_snapshot?.rules?.boostEffects?.[boost.boost_type]?.[boost.rarity] || boost.effect })));
    }
    match = decorateArenaMatch(match, allCards, allBoosts);
    res.render('cards_history', {
      arena: { history: [match] }, replayMatchId: match.id,
      eventContext: { id: event.id, name: event.config.basic.name }
    });
  } catch (err) { next(err); }
});

app.post('/cards/drafts/:eventId/matches/:matchId/turn', requireLogin, requireWutReady, async (req, res) => {
  try {
    const count = Math.max(0, Math.min(2, Number(req.body.count || 0)));
    const placements = Array.from({ length: count }, (_, index) => ({
      slot: req.body[`slot_${index}`], cardId: req.body[`card_id_${index}`], boostId: req.body[`boost_id_${index}`] || null, journeymanKey: req.body[`journeyman_key_${index}`] || ''
    }));
    const input = { eventId: req.params.eventId, matchId: req.params.matchId, userId: req.session.userId, placements };
    if (postgresEnabled) await commitWutDraftEventTurnPostgres(postgresPool(), input);
    else commitWutDraftEventTurn(input);
    await scorePendingArenaMatches();
    req.session.flash = { type: 'success', message: 'Draft Event turn locked in.' };
  } catch (err) { req.session.flash = { type: 'error', message: err.message }; }
  res.redirect(`/cards/drafts/${req.params.eventId}/matches/${req.params.matchId}`);
});

app.post('/cards/drafts/:eventId/matches/:matchId/reveal', requireLogin, requireWutReady, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, matchId: req.params.matchId, userId: req.session.userId };
    if (postgresEnabled) await completeWutDraftEventRevealPostgres(postgresPool(), input);
    else completeWutDraftEventReveal(input);
    return res.redirect(`/cards/drafts/${req.params.eventId}/matches/${req.params.matchId}/results#arena-results`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    return res.redirect(`/cards/drafts/${req.params.eventId}/matches/${req.params.matchId}`);
  }
});

app.post('/cards/drafts/:eventId/join', requireLogin, requireWutReady, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, userId: req.session.userId };
    const event = postgresEnabled ? await joinWutDraftEventPostgres(postgresPool(), input) : joinWutDraftEvent(input);
    req.session.flash = { type: 'success', message: `You joined ${event.config.basic.name}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards/drafts');
});

app.post('/cards/drafts/:eventId/withdraw', requireLogin, requireWutReady, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, userId: req.session.userId };
    const event = postgresEnabled ? await withdrawWutDraftEventPostgres(postgresPool(), input) : withdrawWutDraftEvent(input);
    req.session.flash = { type: 'success', message: `You withdrew from ${event.config.basic.name}. Your entry fee was refunded.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards/drafts');
});

app.post('/cards/wut/join', requireLogin, async (req, res) => {
  try {
    if (postgresEnabled) await joinWutPostgres(postgresPool(), req.session.userId);
    else joinWut(req.session.userId);
    req.session.flash = { type: 'success', message: 'Welcome to WUT. Your starter pack is ready.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards');
});

app.post('/cards/wut/starter-pack', requireLogin, async (req, res) => {
  try {
    const membership = postgresEnabled
      ? await getWutMembershipStatePostgres(postgresPool(), req.session.userId)
      : getWutMembershipState(req.session.userId);
    if (!membership.joined) throw new Error('Join WUT before opening your starter pack.');
    if (membership.starterOpened) throw new Error('Your WUT starter pack has already been opened.');
    const catalog = await getCardsCatalog();
    const config = await getLiveCardsConfig();
    const items = generateWutStarterPack(catalog);
    const bonusPackItems = generateWutPlayerPack({ packType: 'standard', catalog, config });
    const input = { userId: req.session.userId, items, bonusPackItems };
    if (postgresEnabled) await openWutStarterPackPostgres(postgresPool(), input);
    else openWutStarterPack(input);
    req.session.flash = { type: 'success', message: 'Starter pack opened: 2F, 2D, 1G, two Common trinkets, 1,000 WUT Coins, and a free Standard pack waiting in the WUT Shop.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards');
});

app.post('/cards/missions/claim', requireLogin, requireWutReady, async (req, res) => {
  try {
    const input = { userId: req.session.userId, period: req.body.period, missionId: req.body.mission_id };
    const result = postgresEnabled ? await claimWutMissionByIdPostgres(postgresPool(), input) : claimWutMission(input);
    req.session.flash = { type: 'success', message: `${result.mission.reward} WUT Coins claimed from ${result.mission.title}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards#missions');
});

app.get('/cards/collection', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    res.render('cards_collection', await buildArenaCardsHub(req.session.userId));
  } catch (err) {
    next(err);
  }
});

app.get('/cards/arena/matches/:matchId', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    const payload = await buildArenaCardsHub(req.session.userId);
    const matchId = Number(req.params.matchId);
    const match = [...payload.arena.activeMatches, ...payload.arena.readyMatches, ...payload.arena.history]
      .find(item => Number(item.id) === matchId);
    if (!match) return res.status(404).send('WUT match not found.');
    if (Number(match.rules_version || 1) >= 2) {
      const snapshotIds = new Set([...(match.deck_snapshots?.[String(req.session.userId)]?.active || []), ...(match.deck_snapshots?.[String(req.session.userId)]?.bench || [])].map(card => Number(card.card_id)));
      const snapshots = new Map([...(match.deck_snapshots?.[String(req.session.userId)]?.active || []), ...(match.deck_snapshots?.[String(req.session.userId)]?.bench || [])].map(card => [Number(card.card_id), card]));
      payload.cards = payload.cards.filter(card => snapshotIds.has(Number(card.id))).map(card => ({ ...card, power: snapshots.get(Number(card.id))?.power, trinket: snapshots.get(Number(card.id))?.trinket || null }));
    }
    payload.cards = availableWutMatchCards(payload.cards, match.placements, req.session.userId);
    return res.render('cards_match', { ...payload, match });
  } catch (err) {
    return next(err);
  }
});

app.get('/cards/arena/history', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    res.render('cards_history', await buildArenaCardsHub(req.session.userId, req.query));
  } catch (err) {
    next(err);
  }
});

app.post('/cards/arena/enter', requireLogin, requireWutReady, async (req, res) => {
  try {
    let entry;
    if (postgresEnabled) {
      const hub = await buildArenaCardsHub(req.session.userId);
      const deck = (hub.wut.decks || []).find(item => Number(item.id) === Number(req.body.deck_id));
      if (!deck) throw new Error('Select a saved deck before entering the queue.');
      entry = await enterArenaQueuePostgres(postgresPool(), {
        userId: req.session.userId, deckId: deck.id, deckSnapshot: arenaDeckSnapshotFromHub(hub, deck)
      });
    } else {
      const catalog = await getCardsCatalog();
      entry = enterArenaQueue(req.session.userId, req.body.deck_id, arenaCatalogByIdentity(catalog));
    }
    req.session.flash = { type: 'success', message: entry.matchmakingTriggered ? 'Queue reached 10 players. Matchmaking ran immediately.' : 'WUT entry confirmed. Matchmaking will assign your opponent.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards');
});

app.post('/cards/arena/matches/:matchId/turn', requireLogin, requireWutReady, async (req, res) => {
  try {
    const count = Math.max(0, Math.min(2, Number(req.body.count || 0)));
    const placements = Array.from({ length: count }, (_, index) => ({
      slot: req.body[`slot_${index}`],
      cardId: req.body[`card_id_${index}`],
      boostId: req.body[`boost_id_${index}`] || null,
      journeymanKey: req.body[`journeyman_key_${index}`] || ''
    }));
    const input = {
      userId: req.session.userId,
      matchId: req.params.matchId,
      placements
    };
    let catalog = null;
    if (postgresEnabled) await commitArenaTurnPostgres(postgresPool(), input);
    else {
      catalog = await getCardsCatalog();
      commitArenaTurn({ ...input, catalogByIdentity: arenaCatalogByIdentity(catalog) });
    }
    await scorePendingArenaMatches(catalog);
    req.session.flash = { type: 'success', message: 'Turn locked in. Your opponent can now see the committed cards.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/cards/arena/matches/${encodeURIComponent(req.params.matchId)}`);
});

app.post('/cards/arena/matches/:matchId/reveal', requireLogin, requireWutReady, async (req, res) => {
  try {
    if (postgresEnabled) await completeArenaRevealPostgres(postgresPool(), { userId: req.session.userId, matchId: req.params.matchId });
    else completeArenaReveal(req.session.userId, req.params.matchId);
    return res.redirect(`/cards/arena/history?reveal=${encodeURIComponent(req.params.matchId)}#arena-results`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    return res.redirect(`/cards/arena/matches/${encodeURIComponent(req.params.matchId)}`);
  }
});

app.post('/cards/arena/matches/:matchId/claim', requireLogin, requireWutReady, (req, res) => {
  try {
    if (postgresEnabled) {
      req.session.flash = { type: 'success', message: 'Arena rewards are awarded automatically when scoring completes.' };
    } else {
      const result = claimArenaWinnings(req.session.userId, req.params.matchId);
      req.session.flash = { type: 'success', message: result.alreadyAwarded ? `${result.prize} WUT Coins were already awarded.` : `${result.prize} legacy Mushybux collected.` };
    }
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards/arena/history');
});

app.post('/cards/arena/admin/match', requireAdmin, async (req, res) => {
  try {
    const result = postgresEnabled ? await assignArenaMatchupsPostgres(postgresPool(), {}) : assignArenaMatchups();
    await scorePendingArenaMatches();
    req.session.flash = { type: 'success', message: `${result.createdMatchIds.length} WUT matchup${result.createdMatchIds.length === 1 ? '' : 's'} assigned.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards#arena-admin');
});

app.post('/cards/arena/admin/recalculate-elo', requireAdmin, async (req, res) => {
  try {
    const result = postgresEnabled ? await recalculateArenaEloFromHistoryPostgres(postgresPool()) : recalculateArenaEloFromHistory();
    req.session.flash = {
      type: 'success',
      message: `ELO recalculated from ${result.matchesReplayed} completed match${result.matchesReplayed === 1 ? '' : 'es'} for ${result.playersRanked} player${result.playersRanked === 1 ? '' : 's'}.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards#arena-admin');
});

app.get('/cards/arena/debug', requireAdmin, requireWutReady, async (req, res, next) => {
  try {
    const payload = await buildArenaCardsHub(req.session.userId);
    let debugMatch = postgresEnabled ? await getWutDebugMatchPostgres(postgresPool(), req.session.userId) : getWutDebugMatch(req.session.userId);
    if (!debugMatch) debugMatch = postgresEnabled ? await resetWutDebugMatchPostgres(postgresPool(), req.session.userId) : resetWutDebugMatch(req.session.userId);
    const needsRevealData = debugMatch.status === 'completed' && debugMatch.placements.some(row =>
      !Array.isArray(row.rolled_games) || !Array.isArray(row.scoring_effects) || Number(row.reveal_data_version || 0) < 8
    );
    if (needsRevealData && !postgresEnabled && queueWutDebugRescore(req.session.userId)) {
      await scorePendingArenaMatches();
      debugMatch = getWutDebugMatch(req.session.userId);
    }
    debugMatch = decorateArenaMatch(debugMatch, payload.cards, payload.boosts);
    res.render('cards_debug', { ...payload, debugMatch });
  } catch (err) { next(err); }
});

app.post('/cards/arena/debug/reset', requireAdmin, requireWutReady, async (req, res) => {
  if (postgresEnabled) await resetWutDebugMatchPostgres(postgresPool(), req.session.userId); else resetWutDebugMatch(req.session.userId);
  req.session.flash = { type: 'success', message: 'Admin debug game reset.' };
  res.redirect('/cards/arena/debug');
});

app.post('/cards/arena/debug/place', requireAdmin, requireWutReady, async (req, res) => {
  try {
    const catalog = await getCardsCatalog();
    if (postgresEnabled) {
      const hub = await buildArenaCardsHub(req.session.userId); const card = hub.cards.find(item => Number(item.id) === Number(req.body.card_id)); const boost = hub.boosts.find(item => Number(item.id) === Number(req.body.boost_id)) || null;
      await commitWutDebugPlacementPostgres(postgresPool(), { adminUserId:req.session.userId,side:req.body.side,slot:req.body.slot,cardSnapshot:arenaSnapshotForCard(card,hub.wut.config),boost,journeymanKey:req.body.journeyman_key||'',config:await getLiveCardsConfig() });
    } else commitWutDebugPlacement({ adminUserId: req.session.userId, side: req.body.side, slot: req.body.slot,
      cardId: req.body.card_id, boostId: req.body.boost_id || null, journeymanKey: req.body.journeyman_key || '', catalogByIdentity: arenaCatalogByIdentity(catalog) });
    await scorePendingArenaMatches(catalog);
  } catch (err) { req.session.flash = { type: 'error', message: err.message }; }
  res.redirect('/cards/arena/debug');
});

app.post('/cards/legacy-lineup/calculate', requireLogin, async (req, res) => {
  try {
    if (postgresEnabled) throw new Error('The retired weekly lineup mode is unavailable after the WUT 2.0 migration. Use Arena or Draft Events.');
    const settings = getAdminSettings();
    const week = Number(settings.currentWeek);
    const slot = String(req.body.slot || '').toUpperCase();
    const row = getCardsLineup(req.session.userId, week).find(item => item.slot === slot);
    if (!row?.card_id) throw new Error('Choose a historical card for this slot first.');
    if (row.locked || row.resources_resolved) throw new Error('This lineup slot is already locked.');

    const catalog = await getCardsCatalog();
    const catalogByKey = cardsCatalogMap(catalog);
    const owned = getCardsOwnedState(req.session.userId);
    const ownedCard = owned.cards.find(item => Number(item.id) === Number(row.card_id));
    const card = ownedCard ? decorateOwnedCard(ownedCard, catalogByKey) : null;
    if (!card?.player?.position) throw new Error('Card could not be resolved.');
    if (card.edition === 'S3') {
      throw new Error('Only historical cards can be manually calculated.');
    }

    const boost = owned.boosts.find(item => Number(item.id) === Number(row.boost_id)) || null;
    const rawScore = await scoreOwnedCardLineup({ settings, week, row, card, boost });
    if (!rawScore) throw new Error('This historical card could not be calculated.');
    const score = applyChemistryBonus(rawScore, chemistryBonusForCard({
      lineup: getCardsLineup(req.session.userId, week),
      ownedCards: owned.cards,
      catalogByKey,
      card
    }));
    const resolved = resolveCardsLineupResult({
      userId: req.session.userId,
      week,
      slot,
      seriesComplete: true,
      ...score,
      sampleMatchIds: score.sampleMatchIds || [],
      syntheticGames: score.syntheticGames || [],
      scoreBreakdown: score.breakdown || []
    });

    if (!resolved?.finalized) {
      throw new Error(score.warning || 'This historical card could not be calculated.');
    }
    await refreshResolvedChemistryForUserWeek(req.session.userId, week, catalog);
    req.session.flash = { type: 'success', message: `${card.player.name} locked and calculated for ${slot}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards');
});

app.post('/cards/legacy-lineup', requireLogin, async (req, res) => {
  try {
    if (postgresEnabled) throw new Error('The retired weekly lineup mode is unavailable after the WUT 2.0 migration. Use Arena or Draft Events.');
    const settings = getAdminSettings();
    const catalog = await getCardsCatalog();
    const catalogByKey = cardsCatalogMap(catalog);
    const owned = getCardsOwnedState(req.session.userId);
    const card = owned.cards.find(item => Number(item.id) === Number(req.body.card_id)) || null;
    const decoratedCard = card ? decorateOwnedCard(card, catalogByKey) : null;
    const player = decoratedCard?.player || null;
    const slot = String(req.body.slot || '').toUpperCase();
    if (card && (!player || (slot === 'G' ? player.position !== 'G' : player.position !== slot[0]))) {
      throw new Error('That player is not eligible for this lineup slot.');
    }
    const boost = owned.boosts.find(item => Number(item.id) === Number(req.body.boost_id)) || null;
    const targetPosition = player?.position || (slot === 'G' ? 'G' : slot[0]);
    if (boost && !boostFitsPosition(boost, targetPosition)) {
      throw new Error('That boost cannot be used by this position.');
    }
    let seriesKey = String(req.body.selected_series_key || '');
    if (player && decoratedCard.edition === 'S3') {
      const options = await getCardSeriesOptions({
        seasonId: settings.seasonId,
        week: settings.currentWeek,
        divisionId: player.divisionId,
        teamId: player.teamId
      });
      if (!seriesKey && options.length === 1) seriesKey = options[0].seriesKey;
      if (!seriesKey) throw new Error('Choose which series this card will score in.');
      if (!options.some(option => option.seriesKey === seriesKey)) throw new Error('Invalid series selection.');
      const existing = getCardsLineup(req.session.userId, settings.currentWeek)
        .find(row => row.slot === slot);
      const changedSelection =
        Number(existing?.card_id || 0) !== Number(card.id) ||
        String(existing?.selected_series_key || '') !== seriesKey;
      if (changedSelection && !settings.cardsAllowRetroactiveAssignment) {
        const alreadyStarted = await scoreCardSeries({
          seasonId: settings.seasonId,
          divisionId: player.divisionId,
          player,
          position: player.position,
          seriesKey
        });
        if (alreadyStarted.gamesPlayed > 0) {
          throw new Error('That player has already appeared in this series and can no longer be added retroactively.');
        }
      }
    } else if (player) {
      seriesKey = '';
    }
    setCardsLineupSlot({
      userId: req.session.userId,
      week: settings.currentWeek,
      slot,
      cardId: card?.id || null,
      boostId: boost?.id || null,
      selectedSeriesKey: seriesKey
    });
    await refreshResolvedChemistryForUserWeek(req.session.userId, settings.currentWeek, catalog);
    req.session.flash = { type: 'success', message: card ? `${player.name} added to ${slot}.` : `${slot} cleared.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards');
});

app.post('/cards/legacy-week-review/ack', requireLogin, (req, res) => {
  try {
    if (postgresEnabled) throw new Error('Legacy weekly reviews are read-only after the WUT 2.0 migration.');
    acknowledgeCardsWeekReview(req.session.userId, req.body.week);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards');
});

app.get('/cards/store', requireLogin, requireWutReady, async (req, res, next) => {
  try {
    const catalog = await getCardsCatalog();
    const pendingPack = postgresEnabled
      ? await getPendingCardsPackPostgres(postgresPool(), req.session.userId)
      : getPendingCardsPack(req.session.userId);
    const catalogByKey = cardsCatalogMap(catalog);
    const decoratedPack = pendingPack ? {
      ...pendingPack,
      items: pendingPack.items.map(item => ({
        ...item,
        player: item.itemType === 'player'
          ? catalogByKey.get(item.cardIdentity || item.catalogKey) || catalogByKey.get(`${item.edition || 'S3'}|${item.divisionId}|${item.playerKey}`)
          : null
      }))
    } : null;
    const wut = postgresEnabled
      ? await getWutSystemsStatePostgres(postgresPool(), req.session.userId)
      : getWutSystemsState(req.session.userId);
    res.render('cards_store', {
      config: await getLiveCardsConfig(),
      balance: res.locals.currentUser?.balance || 0,
      wut,
      wutCoins: wut.wutCoins,
      pendingPack: decoratedPack
    });
  } catch (err) {
    next(err);
  }
});

app.post('/cards/store/buy', requireLogin, requireWutReady, async (req, res) => {
  try {
    const packKind = String(req.body.pack_kind || '');
    const packType = String(req.body.pack_type || '');
    if (packKind !== 'player' || !['standard', 'premium', 'prestige'].includes(packType)) {
      throw new Error('Invalid pack selection.');
    }
    const config = await getLiveCardsConfig();
    const catalog = await getCardsCatalog();
    const items = generateWutPlayerPack({ packType, catalog, config });
    const prices = config.playerPackPrices;
    const input = {
      userId: req.session.userId,
      week: (postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings()).currentWeek,
      packKind,
      packType,
      price: prices[packType],
      items
    };
    if (postgresEnabled) await createCardsPackPurchasePostgres(postgresPool(), input);
    else createCardsPackPurchase(input);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards/store');
});

app.get('/cards/decks', requireLogin, requireWutReady, async (req, res, next) => {
  try { res.render('cards_decks', await buildArenaCardsHub(req.session.userId)); } catch (err) { next(err); }
});

app.post('/cards/decks/save', requireLogin, requireWutReady, async (req, res) => {
  try {
    const catalog = await getCardsCatalog();
    const input = { userId: req.session.userId, deckId: req.body.deck_id || null, name: req.body.name,
      activeCardIds: [].concat(req.body.active_card_ids || []), benchCardIds: [].concat(req.body.bench_card_ids || []),
      catalogByIdentity: arenaCatalogByIdentity(catalog) };
    if (postgresEnabled) await saveWutDeckPostgres(postgresPool(), input);
    else saveWutDeck(input);
    req.session.flash = { type: 'success', message: 'WUT deck saved.' };
  } catch (err) { req.session.flash = { type: 'error', message: err.message }; }
  res.redirect('/cards/decks');
});

app.post('/cards/decks/slot', requireLogin, requireWutReady, async (req, res) => {
  try { if (postgresEnabled) await buyWutDeckSlotPostgres(postgresPool(), req.session.userId); else buyWutDeckSlot(req.session.userId); req.session.flash = { type: 'success', message: 'Extra saved deck slot purchased.' }; }
  catch (err) { req.session.flash = { type: 'error', message: err.message }; }
  res.redirect('/cards/decks');
});

app.post('/cards/trinkets/buy', requireLogin, requireWutReady, async (req, res) => {
  try { const input = { userId: req.session.userId, slot: req.body.slot }; if (postgresEnabled) await buyWutTrinketPostgres(postgresPool(), input); else buyWutTrinket(input); req.session.flash = { type: 'success', message: 'Trinket added to inventory.' }; }
  catch (err) { req.session.flash = { type: 'error', message: err.message }; } res.redirect('/cards/store');
});
app.post('/cards/trinkets/reroll', requireLogin, requireWutReady, async (req, res) => {
  try { const input = { userId: req.session.userId, currency: req.body.currency }; if (postgresEnabled) await rerollWutTrinketShopPostgres(postgresPool(), input); else rerollWutTrinketShop(input); req.session.flash = { type: 'success', message: 'Trinket shop rerolled.' }; }
  catch (err) { req.session.flash = { type: 'error', message: err.message }; } res.redirect('/cards/store');
});
app.post('/cards/trinkets/attach', requireLogin, requireWutReady, async (req, res) => {
  try { const input = { userId: req.session.userId, cardId: req.body.card_id, trinketId: req.body.trinket_id, catalogByIdentity: arenaCatalogByIdentity(await getCardsCatalog()) }; if (postgresEnabled) await attachWutTrinketPostgres(postgresPool(), input); else attachWutTrinket(input); req.session.flash = { type: 'success', message: 'Trinket attached.' }; }
  catch (err) { req.session.flash = { type: 'error', message: err.message }; } res.redirect('/cards/collection');
});
app.post('/cards/trinkets/remove', requireLogin, requireWutReady, async (req, res) => {
  try { const input = { userId: req.session.userId, cardId: req.body.card_id, currency: req.body.currency }; if (postgresEnabled) await removeWutTrinketPostgres(postgresPool(), input); else removeWutTrinket(input); req.session.flash = { type: 'success', message: 'Trinket removed.' }; }
  catch (err) { req.session.flash = { type: 'error', message: err.message }; } res.redirect('/cards/collection');
});

app.post('/cards/store/claim', requireLogin, requireWutReady, async (req, res) => {
  try {
    if (postgresEnabled) await claimCardsPackPostgres(postgresPool(), { userId: req.session.userId, purchaseId: req.body.purchase_id });
    else claimCardsPack(req.session.userId, req.body.purchase_id);
    req.session.flash = { type: 'success', message: 'Pack added to your collection.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/cards/store');
});

app.get('/betting', requireLogin, async (req, res, next) => {
  try {
    const bettingView = await getBettingView(req);
    const betType = String(req.query.type || 'series').toLowerCase() === 'props' ? 'props' : 'series';
    const activeOdds = postgresEnabled ? await getOddsAdjustmentsForWeekPostgres(postgresPool(), bettingView.week) : getOddsAdjustmentsForWeek(bettingView.week);
    const seasonId = (postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings()).seasonId;
    const [series, closureState] = await Promise.all([
      getUpcomingSeries(bettingView.week, seasonId),
      getBetClosureState({ seasonId, week: bettingView.week })
    ]);
    const betsBySeries = postgresEnabled
      ? await getUserBetsBySeriesPostgres(postgresPool(), req.session.userId, bettingView.week)
      : getUserBetsBySeries(req.session.userId, bettingView.week);
    const board = series.map(s => ({
      ...s,
      markets: buildMarketsForSeries(s, activeOdds),
      goalTotal: getGoalTotalForSeries(s, activeOdds),
      currentBet: betsBySeries[s.series_key] || null,
      bettingClosed: closureState.completedSeriesKeys.has(s.series_key),
      result: closureState.weekResults.seriesResults[s.series_key] || null
    }));

    const propBetsByCategory = postgresEnabled
      ? await getUserPropBetsByCategoryPostgres(postgresPool(), req.session.userId, bettingView.week)
      : getUserPropBetsByCategory(req.session.userId, bettingView.week);
    const rawPropBoards = (await getPropBoards(bettingView.week, seasonId, activeOdds)).map(div => ({
      ...div,
      categories: div.categories.map(cat => ({
        ...cat,
        currentBet: propBetsByCategory[`${div.division_id}|${cat.category}`] || null
      }))
    }));
    const basePropBoards = await filterLeaderPropPools(rawPropBoards, {
      seasonId,
      week: bettingView.week
    });
    const seriesPropMarkets = await buildWeeklyPropMarkets({
      seasonId,
      week: bettingView.week,
      odds: activeOdds,
      publishedOnly: true
    });
    const propBoards = propMarketsToBettingBoards(
      seriesPropMarkets,
      basePropBoards,
      propBetsByCategory
    ).map(board => ({
      ...board,
      bettingClosed: closureState.closedDivisionIds.has(board.division_id)
    }));

    const balanceSummary = postgresEnabled
      ? await getBalanceSummaryForUserPostgres(postgresPool(), req.session.userId)
      : getBalanceSummaryForUser(req.session.userId);
    res.render('betting', { board, propBoards, bettingView, betType, balanceSummary });
  } catch (err) {
    next(err);
  }
});

app.post('/bets', requireLogin, async (req, res) => {
  const bettingView = await getBettingView(req);
  try {
    if (bettingView.locked) throw new Error('Betting is locked for this week.');
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();

    const stake = Number(req.body.stake);
    const activeOdds = postgresEnabled ? await getOddsAdjustmentsForWeekPostgres(postgresPool(), bettingView.week) : getOddsAdjustmentsForWeek(bettingView.week);
    const series = (await getUpcomingSeries(bettingView.week, settings.seasonId)).find(s => s.series_key === req.body.series_key);
    if (!series) throw new Error('Series not found.');
    const closureState = await getBetClosureState({
      seasonId: settings.seasonId,
      week: bettingView.week
    });
    if (closureState.completedSeriesKeys.has(series.series_key)) {
      throw new Error('Betting is closed because this series is complete.');
    }

    const market = buildMarketsForSeries(series, activeOdds).find(m => m.market_key === req.body.market_key);
    if (!market) throw new Error('Market not found.');

    const goalTotalSideRaw = String(req.body.goal_total_side || '').toLowerCase();
    const goalTotalSide = ['over', 'under'].includes(goalTotalSideRaw) ? goalTotalSideRaw : '';
    const seriesGoalTotal = getGoalTotalForSeries(series, activeOdds);
    const goalTotalLine = Number(req.body.goal_total_line || seriesGoalTotal.line || 10.5);
    const goalTotalBoost = Number(seriesGoalTotal.boost || process.env.GOAL_TOTAL_BOOST || 1.5);
    const multiplier = goalTotalSide ? Number((Number(market.multiplier) * goalTotalBoost).toFixed(2)) : Number(market.multiplier);
    const goalTotalLabel = goalTotalSide ? ` + ${goalTotalSide === 'over' ? 'Over' : 'Under'} ${goalTotalLine}` : '';

    const betInput = {
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
    };
    const result = postgresEnabled
      ? await placeOrUpdateSeriesBetPostgres(postgresPool(), betInput)
      : placeOrUpdateBet(betInput);

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
  const bettingView = await getBettingView(req);
  try {
    if (bettingView.locked) throw new Error('Betting is locked for this week.');
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();

    const propKey = String(req.body.prop_key || '');
    const [divisionId, category] = propKey.split('|');
    if (!divisionId || !category) throw new Error('Prop not found.');
    const closureState = await getBetClosureState({
      seasonId: settings.seasonId,
      week: bettingView.week
    });
    if (closureState.closedDivisionIds.has(divisionId)) {
      throw new Error(`${divisionId} prop betting is closed because a series in that division is complete.`);
    }

    const activeOdds = postgresEnabled ? await getOddsAdjustmentsForWeekPostgres(postgresPool(), bettingView.week) : getOddsAdjustmentsForWeek(bettingView.week);
    const basePropBoards = await filterLeaderPropPools(
      await getPropBoards(bettingView.week, settings.seasonId, activeOdds),
      {
        seasonId: settings.seasonId,
        week: bettingView.week
      }
    );
    const seriesPropMarkets = await buildWeeklyPropMarkets({
      seasonId: settings.seasonId,
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

    const betInput = {
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
    };
    const result = postgresEnabled
      ? await placeOrUpdatePropBetPostgres(postgresPool(), betInput)
      : placeOrUpdatePropBet(betInput);

    req.session.flash = {
      type: 'success',
      message: result.action === 'updated' ? 'Prop bet updated.' : 'Prop bet placed.'
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/betting?type=props');
});

app.post('/bets/cancel', requireLogin, async (req, res) => {
  const bettingView = await getBettingView(req);
  const betType = String(req.body.type || 'series').toLowerCase() === 'props' ? 'props' : 'series';

  try {
    if (bettingView.locked) throw new Error('Betting is locked for this week.');
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const userBets = postgresEnabled
      ? await getUserBetsPostgres(postgresPool(), req.session.userId, 10000)
      : getUserBets(req.session.userId, 10000);
    const bet = userBets.find(
      candidate => Number(candidate.id) === Number(req.body.bet_id)
    );
    if (!bet) throw new Error('Bet not found.');
    const closureState = await getBetClosureState({
      seasonId: settings.seasonId,
      week: bettingView.week
    });
    if ((bet.bet_kind || 'series') === 'series' &&
      closureState.completedSeriesKeys.has(String(bet.series_key || ''))) {
      throw new Error('This bet cannot be cancelled because its series is complete.');
    }
    if (bet.bet_kind === 'prop' &&
      closureState.closedDivisionIds.has(String(bet.division_id || ''))) {
      throw new Error(`${bet.division_id} prop betting is closed for this week.`);
    }

    const cancelInput = {
      userId: req.session.userId,
      betId: req.body.bet_id,
      locked: bettingView.locked
    };
    const result = postgresEnabled
      ? await cancelOpenBetPostgres(postgresPool(), cancelInput)
      : cancelOpenBet(cancelInput);

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
  const user = res.locals.currentUser;
  if (!user || user.role !== 'admin') return res.status(403).send('Admin only.');
  next();
}

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const currentWeek = Number(settings.currentWeek || 1);
    const nextWeek = currentWeek + 1;
    const oddsWeekMode = String(req.query.odds_week || '') === 'current' ? 'current' : 'next';
    const oddsWeek = oddsWeekMode === 'current' ? currentWeek : nextWeek;
    const currentWeekBets = postgresEnabled ? await getAdminBetsForWeekPostgres(postgresPool(), currentWeek) : getAdminBetsForWeek(currentWeek);
    const reviewableWeekBets = postgresEnabled ? await getAdminBetsForWeekPostgres(postgresPool(), currentWeek, ['open', 'settled']) : getAdminBetsForWeek(currentWeek, ['open', 'settled']);
    const nextWeekBets = postgresEnabled ? await getAdminBetsForWeekPostgres(postgresPool(), nextWeek) : getAdminBetsForWeek(nextWeek);
    const users = postgresEnabled ? await getUserSummariesPostgres(postgresPool()) : getUserSummaries();
    const seasons = await getAvailableSeasons();
    const reviewedOdds = postgresEnabled ? await getOddsAdjustmentsForWeekPostgres(postgresPool(), oddsWeek) : getOddsAdjustmentsForWeek(oddsWeek);
    const currentWeekSeries = await getUpcomingSeries(currentWeek, settings.seasonId);
    const seriesBetReview = await buildSeriesBetReview({
      seasonId: settings.seasonId,
      week: currentWeek,
      series: currentWeekSeries,
      bets: reviewableWeekBets
    });
    const voidRefunds = postgresEnabled ? await getVoidRefundsForWeekPostgres(postgresPool(), currentWeek) : getVoidRefundsForWeek(currentWeek);
    const backupInfo = getBackupInfo();
    const casinoSummary = postgresEnabled ? await getCasinoSummaryPostgres(postgresPool()) : getCasinoSummary();
    const cardsAdmin = postgresEnabled ? await getCardsAdminStatePostgres(postgresPool()) : getCardsAdminState();
    const cardsCatalog = sortCardsCatalogForAdmin(await getCardsCatalog());
    let settlementPreview = null;
    let settledBetAudit = null;
    let seriesOddsRecommendations = null;
    let propOddsRecommendations = [];
    let leaderPropRecommendations = [];

    try {
      const weekResults = await buildWeekSettlementResults({ seasonId: settings.seasonId, week: currentWeek });
      settlementPreview = buildSettlementPreview({
        week: currentWeek,
        weekResults,
        evaluator: evaluateBetAgainstResults,
        bets: postgresEnabled ? currentWeekBets : undefined
      });
    } catch (err) {
      settlementPreview = { error: err.message };
    }

    if (String(req.query.audit_settled || '') === '1') {
      try {
        settledBetAudit = await buildSettledBetAudit({ seasonId: settings.seasonId });
      } catch (err) {
        settledBetAudit = { error: err.message };
      }
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
      seriesBetReview,
      voidRefunds,
      nextWeekBets,
      openWeekBets: nextWeekBets,
      users,
      seasons,
      settlementPreview,
      settledBetAudit,
      seriesOddsRecommendations,
      propOddsRecommendations,
      leaderPropRecommendations,
      backupInfo,
      casinoSummary,
      cardsAdmin,
      cardsCatalog,
      cardStars: CARD_STARS,
      cardCooldowns: CARD_COOLDOWNS,
      boostEffects: cardsAdmin.config.boostEffects,
      boostTypes: BOOST_TYPES,
      trinketAdminFields: WUT_TRINKET_ADMIN_FIELDS
    });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/cards/matches', requireAdmin, async (req, res, next) => {
  try {
    const selectedUserId = Number(req.query.user_id) || null;
    res.render('admin_cards_matches', {
      arenaMatches: postgresEnabled ? await getArenaAdminMatchStatePostgres(postgresPool(), { userId: selectedUserId }) : getArenaAdminMatchState({ userId: selectedUserId })
    });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/cards/matches/:matchId/void', requireAdmin, async (req, res) => {
  try {
    const input = {
      matchId: req.params.matchId,
      adminUserId: req.session.userId,
      reason: req.body.reason
    };
    const result = postgresEnabled ? await adminVoidArenaMatchPostgres(postgresPool(), input) : adminVoidArenaMatch(input);
    const released = result.releasedBoostIds.length
      ? ` ${result.releasedBoostIds.length} committed boost${result.releasedBoostIds.length === 1 ? '' : 's'} returned.`
      : '';
    const refunded = result.refundedMushybux ? ` ${result.refundedMushybux} Mushybux refunded.` : '';
    req.session.flash = { type: 'success', message: `WUT match #${result.match.id} cancelled and voided.${released}${refunded}` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  const userId = Number(req.body.return_user_id) || '';
  res.redirect(`/admin/cards/matches${userId ? `?user_id=${userId}` : ''}`);
});

app.get('/admin/cards/drafts', requireAdmin, async (req, res, next) => {
  try {
    res.render('admin_draft_events', {
      draftPresets: postgresEnabled ? await getWutDraftEventPresetsPostgres(postgresPool()) : getWutDraftEventPresets(),
      draftEvents: postgresEnabled
        ? await getDraftEventLobbyPostgres(postgresPool(), { userId: req.session.userId, includePrivate: true })
        : getWutDraftEventLobby({ userId: req.session.userId, includePrivate: true }),
      draftTransitions: WUT_DRAFT_TRANSITIONS
    });
  } catch (err) {
    next(err);
  }
});

function parsedDraftConfig(body) {
  try {
    return JSON.parse(String(body.config_json || ''));
  } catch {
    throw new Error('The Draft Event configuration could not be read. Reload the builder and try again.');
  }
}

app.post('/admin/cards/drafts/events', requireAdmin, async (req, res) => {
  try {
    const input = {
      config: parsedDraftConfig(req.body),
      presetId: req.body.preset_id || null,
      adminUserId: req.session.userId
    };
    const event = postgresEnabled ? await createWutDraftEventPostgres(postgresPool(), input) : createWutDraftEvent(input);
    req.session.flash = { type: 'success', message: `Draft Event #${event.id}, ${event.config.basic.name}, was published.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/presets', requireAdmin, async (req, res) => {
  try {
    const input = {
      presetId: req.body.update_selected === '1' ? req.body.preset_id : null,
      name: req.body.preset_name,
      description: req.body.preset_description,
      config: parsedDraftConfig(req.body),
      adminUserId: req.session.userId
    };
    const preset = postgresEnabled ? await saveWutDraftEventPresetPostgres(postgresPool(), input) : saveWutDraftEventPreset(input);
    req.session.flash = { type: 'success', message: `Draft preset “${preset.name}” was saved.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

async function draftEnvironmentFromCatalog(event, catalog) {
  const { boosterCards, benchCards } = splitWutDraftCardPools(event.config, catalog);
  const cards = boosterCards.map(snapshotWutDraftCard);
  const global = await getLiveCardsConfig();
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  return {
    season_id: settings.seasonId,
    cards,
    bench_cards: benchCards.map(snapshotWutDraftCard),
    rules: {
      scoring: global.scoring,
      boostEffects: global.boostEffects,
      rarityCosts: global.wut.rarityCosts,
      trinketPowerValues: global.wut.trinketPowerValues,
      slotPowerAllowance: global.wut.slotPowerAllowance,
      trinketEffects: global.wut.trinketEffects
    }
  };
}

app.post('/admin/cards/drafts/:eventId/phase', requireAdmin, async (req, res) => {
  try {
    const nextPhase = req.body.next_phase;
    let event;
    if (nextPhase === 'starting') {
      const current = (postgresEnabled
        ? await getDraftEventLobbyPostgres(postgresPool(), { eventId: req.params.eventId, includePrivate: true })
        : getWutDraftEventLobby({ eventId: req.params.eventId, includePrivate: true }))[0];
      const environment = await draftEnvironmentFromCatalog(current, await getCardsCatalog());
      const input = { eventId: req.params.eventId, environment, adminUserId: req.session.userId };
      event = postgresEnabled ? await startWutDraftEventPostgres(postgresPool(), input) : startWutDraftEvent(input);
    } else if (nextPhase === 'bench_vote') {
      const current = (postgresEnabled
        ? await getDraftEventLobbyPostgres(postgresPool(), { eventId: req.params.eventId, includePrivate: true })
        : getWutDraftEventLobby({ eventId: req.params.eventId, includePrivate: true }))[0];
      const environment = await draftEnvironmentFromCatalog(current, await getCardsCatalog());
      const input = { eventId: req.params.eventId, adminUserId: req.session.userId, benchCards: environment.bench_cards };
      event = postgresEnabled ? await beginWutDraftSafetyBenchPostgres(postgresPool(), input) : beginWutDraftSafetyBench(input);
    } else if (nextPhase === 'draft') {
      const input = { eventId: req.params.eventId, adminUserId: req.session.userId };
      event = postgresEnabled ? await beginWutDraftEventPostgres(postgresPool(), input) : beginWutDraftEvent(input);
    } else {
      const input = { eventId: req.params.eventId, nextPhase, adminUserId: req.session.userId, reason: req.body.reason };
      event = postgresEnabled ? await transitionWutDraftEventPostgres(postgresPool(), input) : transitionWutDraftEvent(input);
    }
    req.session.flash = { type: 'success', message: `Draft Event #${event.id} moved to ${event.phase.replaceAll('_', ' ')}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/start-now', requireAdmin, async (req, res) => {
  try {
    const current = (postgresEnabled
      ? await getDraftEventLobbyPostgres(postgresPool(), { eventId: req.params.eventId, includePrivate: true })
      : getWutDraftEventLobby({ eventId: req.params.eventId, includePrivate: true }))[0];
    if (!['scheduled', 'signup_open', 'signup_closed'].includes(current.phase)) throw new Error('This Draft Event is not waiting to start.');
    const environment = await draftEnvironmentFromCatalog(current, await getCardsCatalog());
    const startInput = { eventId: req.params.eventId, environment, adminUserId: req.session.userId, startNow: true };
    if (postgresEnabled) await startWutDraftEventPostgres(postgresPool(), startInput);
    else startWutDraftEvent(startInput);
    const benchInput = { eventId: req.params.eventId, adminUserId: req.session.userId };
    const event = postgresEnabled ? await beginWutDraftSafetyBenchPostgres(postgresPool(), benchInput) : beginWutDraftSafetyBench(benchInput);
    req.session.flash = { type: 'success', message: `Draft Event #${event.id} started early and is now in ${event.phase.replaceAll('_', ' ')}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/bench/finish', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId, reason: req.body.reason };
    if (postgresEnabled) await finishWutDraftSafetyBenchPostgres(postgresPool(), input);
    else finishWutDraftSafetyBench(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} Safety Bench was finalized.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/bench/extend', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId, seconds: req.body.seconds };
    if (postgresEnabled) await extendWutDraftSafetyBenchPostgres(postgresPool(), input);
    else extendWutDraftSafetyBench(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} Safety Bench timer was extended.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/draft/autopick', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, userId: req.body.user_id || null, adminUserId: req.session.userId };
    const result = postgresEnabled ? await forceWutDraftAutopickPostgres(postgresPool(), input) : forceWutDraftAutopick(input);
    req.session.flash = { type: 'success', message: `${result.picks.length} forced autopick${result.picks.length === 1 ? '' : 's'} completed.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/draft/extend', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId, seconds: req.body.seconds };
    if (postgresEnabled) await extendWutDraftPickDeadlinePostgres(postgresPool(), input);
    else extendWutDraftPickDeadline(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} pick timer was extended.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/deckbuilding/finish', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId, autosubmitMissing: true };
    if (postgresEnabled) await finishWutDraftDeckbuildingPostgres(postgresPool(), input);
    else finishWutDraftDeckbuilding(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} decks were locked; missing decks were autosubmitted.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/deckbuilding/extend', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId, seconds: req.body.seconds };
    if (postgresEnabled) await extendWutDraftDeckbuildingPostgres(postgresPool(), input);
    else extendWutDraftDeckbuilding(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} deckbuilding timer was extended.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/tournament/advance', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId };
    const event = postgresEnabled ? await advanceWutDraftEventRoundPostgres(postgresPool(), input) : advanceWutDraftEventRound(input);
    req.session.flash = { type: 'success', message: `Draft Event #${event.id} advanced to ${event.phase === 'tournament' ? `round ${event.tournament.round}` : event.phase}.` };
  } catch (err) { req.session.flash = { type: 'error', message: err.message }; }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/prizes/award', requireAdmin, async (req, res) => {
  try {
    let result;
    if (postgresEnabled) {
      const catalog = await getCardsCatalog(); const config = await getLiveCardsConfig();
      result = await awardWutDraftEventPrizesPostgres(postgresPool(), {
        eventId: req.params.eventId, adminUserId: req.session.userId,
        generatePack: packType => generateWutPlayerPack({ packType, catalog, config })
      });
    } else result = (await awardCompletedWutDraftEvents(null, req.params.eventId, req.session.userId))[0];
    req.session.flash = { type: 'success', message: result ? `Awarded ${result.awards.length} Draft Event prize item${result.awards.length === 1 ? '' : 's'} and retired temporary inventories.` : 'Draft Event prizes were already awarded.' };
  } catch (err) { req.session.flash = { type: 'error', message: err.message }; }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/reschedule', requireAdmin, async (req, res) => {
  try {
    const input = {
      eventId: req.params.eventId, adminUserId: req.session.userId,
      signupOpensAt: req.body.signup_opens_at, signupClosesAt: req.body.signup_closes_at, startsAt: req.body.starts_at
    };
    if (postgresEnabled) await rescheduleWutDraftEventPostgres(postgresPool(), input); else rescheduleWutDraftEvent(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} schedule updated.` };
  } catch (err) { req.session.flash = { type: 'error', message: err.message }; }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/entrants/:userId/drop', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, userId: req.params.userId, adminUserId: req.session.userId, reason: req.body.reason };
    if (postgresEnabled) await dropWutDraftEventEntrantPostgres(postgresPool(), input); else dropWutDraftEventEntrant(input);
    req.session.flash = { type: 'success', message: `Player ${req.params.userId} was dropped from Draft Event #${req.params.eventId}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/matches/:matchId/resolve', requireAdmin, async (req, res) => {
  try {
    const input = {
      eventId: req.params.eventId, matchId: req.params.matchId, action: req.body.action,
      forfeitingUserId: req.body.forfeiting_user_id, adminUserId: req.session.userId, reason: req.body.reason
    };
    if (postgresEnabled) await resolveWutDraftEventMatchPostgres(postgresPool(), input);
    else resolveWutDraftEventMatch(input);
    req.session.flash = { type: 'success', message: `Draft Event match ${req.params.matchId} was ${req.body.action === 'void' ? 'voided' : req.body.action === 'reset' ? 'reset to its opening turn' : 'resolved by forfeit'}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/tournament/reset-round', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId, reason: req.body.reason };
    const event = postgresEnabled ? await resetCurrentWutDraftEventRoundPostgres(postgresPool(), input) : resetCurrentWutDraftEventRound(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} round ${event.tournament.round} was reset. Every game in the round will restart.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/pause', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId, reason: req.body.reason };
    if (postgresEnabled) await pauseWutDraftEventPostgres(postgresPool(), input); else pauseWutDraftEvent(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} paused.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});

app.post('/admin/cards/drafts/:eventId/resume', requireAdmin, async (req, res) => {
  try {
    const input = { eventId: req.params.eventId, adminUserId: req.session.userId };
    if (postgresEnabled) await resumeWutDraftEventPostgres(postgresPool(), input); else resumeWutDraftEvent(input);
    req.session.flash = { type: 'success', message: `Draft Event #${req.params.eventId} resumed.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/cards/drafts');
});



app.post('/admin/backup/create', requireAdmin, async (req, res) => {
  try {
    const backup = postgresEnabled
      ? await createPostgresJsonBackup(postgresPool())
      : createJsonBackup();
    req.session.flash = { type: 'success', message: `Created backup: ${backup.filename}` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/maintenance', requireAdmin, async (req, res) => {
  const enabled = String(req.body.enabled || '') === 'true';
  const settings = postgresEnabled
    ? await setMaintenanceModePostgres(postgresPool(), enabled, req.body.message)
    : setMaintenanceMode(enabled, req.body.message);
  req.session.flash = {
    type: 'success',
    message: settings.maintenanceMode
      ? 'Maintenance mode enabled. User traffic and background game clocks are frozen.'
      : 'Maintenance mode disabled. The website is open again.'
  };
  res.redirect('/admin');
});

app.get('/admin/backup/download', requireAdmin, async (req, res) => {
  if (postgresEnabled) {
    const { state, json } = await serializePostgresState(postgresPool());
    const filename = `wcpl-betting-week-${Number(state.settings?.currentWeek || 1)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(json);
  }
  const filePath = getDatabasePath();
  if (!fs.existsSync(filePath)) {
    req.session.flash = { type: 'error', message: 'No betting database exists yet.' };
    return res.redirect('/admin');
  }
  const settings = getAdminSettings();
  const filename = `wcpl-betting-week-${settings.currentWeek}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  res.download(filePath, filename);
});

app.post('/admin/casino/open', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { casinoOpen: true }); else setCasinoOpen(true);
  req.session.flash = { type: 'success', message: 'Casino opened. Users can wager again.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/close', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { casinoOpen: false }); else setCasinoOpen(false);
  req.session.flash = { type: 'success', message: 'Casino closed. All casino wagering and gameplay is disabled.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/horse-racing-config', requireAdmin, async (req, res) => {
  try {
    const input = {
      maxBet: req.body.max_bet,
      horsePurchasePrice: req.body.horse_purchase_price,
      ownerBetSharePercent: req.body.owner_bet_share_percent,
      ownerWinBonus: req.body.owner_win_bonus
    };
    if (postgresEnabled) await saveHorseRacingConfigPostgres(postgresPool(), input); else saveHorseRacingConfig(input);
    req.session.flash = { type: 'success', message: 'Horse racing settings saved.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/show-link', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { casinoLinkVisible: true }); else setCasinoLinkVisible(true);
  req.session.flash = { type: 'success', message: 'Casino navigation link is now visible.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/hide-link', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { casinoLinkVisible: false }); else setCasinoLinkVisible(false);
  req.session.flash = { type: 'success', message: 'Casino navigation link is now hidden.' };
  res.redirect('/admin#casino-controls');
});

app.post('/admin/casino/reset', requireAdmin, (req, res) => {
  try {
    if (postgresEnabled) throw new Error('Casino hard reset is intentionally disabled on PostgreSQL. Use a verified backup restore for destructive production recovery.');
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

app.post('/admin/cards/show-link', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { cardsLinkVisible: true }); else setCardsLinkVisible(true);
  req.session.flash = { type: 'success', message: 'Cards navigation link is now visible.' };
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/open', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { cardsOpen: true }); else setCardsOpen(true);
  req.session.flash = { type: 'success', message: 'WUT opened. All WUT features are available again.' };
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/close', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { cardsOpen: false }); else setCardsOpen(false);
  req.session.flash = { type: 'success', message: 'WUT closed. All WUT activity and matchmaking are paused.' };
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/hide-link', requireAdmin, async (req, res) => {
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { cardsLinkVisible: false }); else setCardsLinkVisible(false);
  req.session.flash = { type: 'success', message: 'Cards navigation link is now hidden.' };
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/retroactive-assignment', requireAdmin, async (req, res) => {
  const allowed = String(req.body.allowed || '') === 'true';
  if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { cardsAllowRetroactiveAssignment: allowed }); else setCardsAllowRetroactiveAssignment(allowed);
  req.session.flash = {
    type: 'success',
    message: allowed
      ? 'Testing override enabled: players may be assigned after their series has started.'
      : 'Testing override disabled: retroactive Cards assignments are blocked.'
  };
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/config', requireAdmin, async (req, res) => {
  try {
    if (postgresEnabled) await saveCardsConfigPostgres(postgresPool(), req.body); else saveCardsConfig(req.body);
    await getLiveCardsConfig();
    req.session.flash = { type: 'success', message: 'WUT economy, match rules, boosts, missions, and trinket balance saved.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/free-shop', requireAdmin, async (req, res) => {
  const enabled = String(req.body.enabled || '') === 'true';
  if (postgresEnabled) await setWutFreeShopPurchasesPostgres(postgresPool(), enabled); else setWutFreeShopPurchases(enabled);
  req.session.flash = { type: 'success', message: enabled ? 'Free WUT shop purchases enabled for testing.' : 'Normal WUT shop pricing restored.' };
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/wut-coins', requireAdmin, async (req, res) => {
  try {
    const input = {
      userId: req.body.user_id,
      amount: req.body.amount,
      note: req.body.note,
      adminUserId: req.session.userId
    };
    const result = postgresEnabled ? await adjustWutCoinBalancePostgres(postgresPool(), input) : adjustWutCoinBalance(input);
    req.session.flash = { type: 'success', message: `Adjusted WUT balance by ${result.amount > 0 ? '+' : ''}${result.amount}. New balance: ${result.balance} WUT Coins.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/position', requireAdmin, async (req, res) => {
  try {
    if (postgresEnabled) await setCardsPositionOverridePostgres(postgresPool(), req.body.catalog_key, req.body.position); else setCardsPositionOverride(req.body.catalog_key, req.body.position);
    req.session.flash = { type: 'success', message: 'Card position override saved.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-player-pools');
});

app.post('/admin/cards/tier', requireAdmin, async (req, res) => {
  try {
    if (postgresEnabled) await setCardsTierOverridePostgres(postgresPool(), req.body.catalog_key, req.body.tier); else setCardsTierOverride(req.body.catalog_key, req.body.tier);
    req.session.flash = { type: 'success', message: 'Card tier override saved.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-player-pools');
});

app.post('/admin/cards/player-overrides', requireAdmin, async (req, res) => {
  try {
    const input = { positions: req.body.positions, tiers: req.body.tiers };
    const result = postgresEnabled ? await setCardsPlayerOverridesPostgres(postgresPool(), input) : setCardsPlayerOverrides(input);
    const positions = result.positionOverrides || result.positions || {}; const tiers = result.tierOverrides || result.tiers || {};
    req.session.flash = {
      type: 'success',
      message: `Saved ${Object.keys(positions).length} position and ${Object.keys(tiers).length} rarity override(s).`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-player-pools');
});

app.post('/admin/cards/recalculate', requireAdmin, async (req, res) => {
  try {
    const catalog = await getCardsCatalog();
    if (postgresEnabled) await saveCalculatedCardTiersPostgres(postgresPool(), catalog); else saveCalculatedCardTiers(catalog);
    req.session.flash = { type: 'success', message: `Recalculated ${catalog.length} card player tiers.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-player-pools');
});

app.post('/admin/cards/grant', requireAdmin, async (req, res) => {
  try {
    const catalog = await getCardsCatalog();
    const itemType = String(req.body.item_type || 'player');
    let item;
    if (itemType === 'trinket') {
      item = {
        itemType: 'trinket',
        family: String(req.body.trinket_family || ''),
        rarity: String(req.body.rarity || 'common')
      };
    } else if (itemType === 'boost') {
      const rarity = String(req.body.rarity || 'common');
      const boostType = String(req.body.boost_type || 'goal');
      item = {
        itemType: 'boost',
        boostType,
        rarity,
        effect: (await getLiveCardsConfig()).boostEffects?.[boostType]?.[rarity] || DEFAULT_BOOST_EFFECTS[boostType]?.[rarity]
      };
    } else {
      const player = catalog.find(entry => entry.catalogKey === req.body.catalog_key);
      if (!player) throw new Error('Choose a player.');
      item = {
        itemType: 'player',
        cardIdentity: player.cardIdentity || player.catalogKey,
        catalogKey: player.catalogKey,
        cardType: player.cardType || 'player',
        cardArt: player.cardArt || player.card_art || player.edition || 'S3',
        edition: player.edition || 'S3',
        sourceSeason: player.sourceSeason || player.edition || 'S3',
        sourceStage: player.sourceStage || 'reg',
        sourceTeamId: player.sourceTeamId || player.teamId,
        sourcePlayerKey: player.sourcePlayerKey || player.playerKey,
        sourceSteamId: player.sourceSteamId || player.steamId,
        displayName: player.displayName || player.name,
        divisionId: player.divisionId,
        playerKey: player.playerKey,
        rolledTier: player.tier
      };
    }
    const input = { userId: req.body.user_id, item };
    if (postgresEnabled) await grantCardsTestItemPostgres(postgresPool(), input); else grantCardsTestItem(input);
    req.session.flash = { type: 'success', message: 'Test Cards item granted.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-controls');
});

app.post('/admin/cards/reset', requireAdmin, (req, res) => {
  try {
    if (postgresEnabled) throw new Error('WUT hard reset is intentionally disabled on PostgreSQL. Use the migration/import recovery tools with a verified backup.');
    const result = resetCardsData();
    req.session.flash = {
      type: 'success',
      message: `Cards data reset. Restored ${result.usersRestored} user balance(s).`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#cards-controls');
});

app.post('/admin/season', requireAdmin, async (req, res) => {
  try {
    const seasonId = String(req.body.season_id || '').trim();
    if (!seasonId) throw new Error('Season ID is required.');
    const settings = postgresEnabled
      ? await patchSettingsPostgres(postgresPool(), { seasonId, currentWeek: 1, lockedWeeks: [], bettingLocked: false })
      : setSeasonId(seasonId);
    req.session.flash = { type: 'success', message: `Switched debug season to ${settings.seasonId}. Week reset to 1.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/settle-week', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
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
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const week = Number(req.body.week || settings.currentWeek);
    const result = await settleCompletedBetsOrThrow({ week, seasonId: settings.seasonId });
    req.session.flash = { type: 'success', message: `Settled completed Week ${week} bets: ${result.winners} winner(s), ${result.losers} loser(s), ${result.payoutTotal} Mushybux paid. ${result.skipped} bet(s) still unresolved.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/correct-settled-bet', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const betId = Number(req.body.bet_id);
    const settledBets = postgresEnabled
      ? await getAdminSettledBetsPostgres(postgresPool())
      : getAdminSettledBets();
    const bet = settledBets.find(item => Number(item.id) === betId);
    if (!bet) throw new Error('Settled bet not found.');
    const weekResults = await buildWeekSettlementResults({ seasonId: settings.seasonId, week: bet.week });
    const evaluation = evaluateBetAgainstResults(bet, weekResults);
    const input = { betId, week: bet.week, evaluation, adminUserId: req.session.userId };
    const result = postgresEnabled
      ? await correctSettledBetPostgres(postgresPool(), input)
      : correctSettledBet(input);
    const delta = `${result.delta > 0 ? '+' : ''}${result.delta}`;
    req.session.flash = {
      type: 'success',
      message: `Corrected bet #${result.betId}: ${result.oldWon ? 'win' : 'loss'} to ${result.newWon ? 'win' : 'loss'}, payout ${result.oldPayout} to ${result.newPayout}. User balance adjusted ${delta} Mushybux.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin?audit_settled=1#settled-bet-audit');
});

app.post('/admin/refund-bet', requireAdmin, async (req, res) => {
  try {
    const result = postgresEnabled
      ? await voidBetByIdPostgres(postgresPool(), req.body.bet_id, 'Manual admin refund')
      : voidBetById(req.body.bet_id, 'Manual admin refund');
    req.session.flash = { type: 'success', message: `Refunded ${result.refunded} Mushybux and voided ${result.count} bet.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/void-series', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const week = Number(req.body.week || settings.currentWeek);
    const seriesKey = String(req.body.series_key || '').trim();
    const payload = await buildSeriesVoidPayload({ seasonId: settings.seasonId, week, seriesKey });
    const input = {
      week,
      seriesKey,
      teamIds: payload.teamIds,
      playerKeys: payload.playerKeys,
      reason: `Postponed series refund (${payload.series.away_team_name} at ${payload.series.home_team_name})`
    };
    const result = postgresEnabled ? await voidBetsForSeriesPostgres(postgresPool(), input) : voidBetsForSeries(input);
    req.session.flash = { type: 'success', message: `Voided postponed series bets: ${result.seriesCount} series bet(s), ${result.propCount} prop bet(s), ${result.refunded} Mushybux refunded.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/lock', requireAdmin, async (req, res) => {
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  try {
    const opportunities = await buildWutMissionBetOpportunities({
      seasonId: settings.seasonId,
      week: settings.currentWeek
    });
    if (postgresEnabled) {
      await setWutMissionBetOpportunitiesPostgres(postgresPool(), { week: settings.currentWeek, opportunities, locked: true });
      await setWeekLockedPostgres(postgresPool(), settings.currentWeek, true);
    } else {
      setWutMissionBetOpportunities({ week: settings.currentWeek, opportunities, locked: true });
      setWeekLocked(settings.currentWeek, true);
    }
    req.session.flash = { type: 'success', message: `Week ${settings.currentWeek} betting locked with ${opportunities.length} WUT mission option(s).` };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Betting was not locked: ${err.message}` };
  }
  res.redirect('/admin');
});

app.post('/admin/unlock', requireAdmin, async (req, res) => {
  const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
  if (postgresEnabled) await setWeekLockedPostgres(postgresPool(), settings.currentWeek, false); else setWeekLocked(settings.currentWeek, false);
  req.session.flash = { type: 'success', message: `Week ${settings.currentWeek} betting unlocked.` };
  res.redirect('/admin');
});

app.post('/admin/allowance', requireAdmin, async (req, res) => {
  try {
    const amount = Number(req.body.weekly_allowance);
    if (!Number.isInteger(amount) || amount < 0) throw new Error('Weekly allowance must be a non-negative whole number.');
    if (postgresEnabled) await patchSettingsPostgres(postgresPool(), { weeklyAllowance: amount }); else setWeeklyAllowance(amount);
    req.session.flash = { type: 'success', message: 'Weekly allowance updated.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/apply-allowance', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const result = postgresEnabled
      ? await applyWeeklyAllowancePostgres(postgresPool(), settings.currentWeek)
      : applyWeeklyAllowance(settings.currentWeek);
    req.session.flash = { type: 'success', message: `Applied ${result.amount} Mushybux allowance to ${result.count} users.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/reset-week-bets', requireAdmin, async (req, res) => {
  try {
    const week = Number(req.body.week);
    const result = postgresEnabled ? await resetBetsForWeekPostgres(postgresPool(), week) : resetBetsForWeek(week);
    req.session.flash = { type: 'success', message: `Voided ${result.count} Week ${week} bets and refunded ${result.refunded} Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

// Backwards-compatible route from earlier admin page versions.
app.post('/admin/reset-open-bets', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const nextWeek = Number(settings.currentWeek || 1) + 1;
    const result = postgresEnabled ? await resetBetsForWeekPostgres(postgresPool(), nextWeek) : resetBetsForWeek(nextWeek);
    req.session.flash = { type: 'success', message: `Voided ${result.count} Week ${nextWeek} bets and refunded ${result.refunded} Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/reset-all-data', requireAdmin, (req, res) => {
  if (postgresEnabled) req.session.flash = { type: 'error', message: 'Full database reset is intentionally disabled on PostgreSQL. Restore or replace from a verified backup instead.' };
  else { resetAllData(); req.session.flash = { type: 'success', message: 'All test data reset.' }; }
  res.redirect('/admin');
});

app.post('/admin/advance-week', requireAdmin, async (req, res) => {
  try {
    const before = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const openCount = postgresEnabled ? await getOpenBetCountForWeekPostgres(postgresPool(), before.currentWeek) : getOpenBetCountForWeek(before.currentWeek);
    if (openCount > 0) {
      throw new Error(`Week ${before.currentWeek} still has ${openCount} unsettled open bet(s). Settle completed bets, wait for incomplete results, or refund/void them before advancing.`);
    }
    const targetWeek = Number(before.currentWeek) + 1;
    const targetSeries = await getUpcomingSeries(targetWeek, before.seasonId);
    const targetOdds = postgresEnabled ? await getOddsAdjustmentsForWeekPostgres(postgresPool(), targetWeek) : getOddsAdjustmentsForWeek(targetWeek);
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

    const retiredProps = postgresEnabled ? await voidDeprecatedHatTrickBetsForWeekPostgres(postgresPool(), targetWeek) : voidDeprecatedHatTrickBetsForWeek(targetWeek);
    const after = postgresEnabled ? await advanceWeekPostgres(postgresPool()) : advanceWeek();
    const allowance = postgresEnabled ? await applyWeeklyAllowancePostgres(postgresPool(), after.currentWeek) : applyWeeklyAllowance(after.currentWeek);
    req.session.flash = {
      type: 'success',
      message: `Advanced to Week ${after.currentWeek}. Betting is open, and ${allowance.amount} Mushybux allowance was applied to ${allowance.count} users.${retiredProps.count ? ` Voided ${retiredProps.count} retired hat-trick bet(s) and refunded ${retiredProps.refunded} Mushybux.` : ''}`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/adjust-balance', requireAdmin, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const note = String(req.body.note || '').trim();
    if (postgresEnabled) await adjustUserBalancePostgres(postgresPool(), req.body.user_id, amount, note); else adjustUserBalance(req.body.user_id, amount, note);
    req.session.flash = { type: 'success', message: `Balance adjusted by ${amount} Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/adjust-all-balances', requireAdmin, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const note = String(req.body.note || '').trim();
    const result = postgresEnabled ? await adjustAllUserBalancesPostgres(postgresPool(), amount, note) : adjustAllUserBalances(amount, note);
    req.session.flash = {
      type: 'success',
      message: `Adjusted ${result.count} user balances by ${result.amount > 0 ? '+' : ''}${result.amount} Mushybux each.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#user-balances');
});

app.post('/admin/add-user', requireAdmin, async (req, res) => {
  try {
    const input = {
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.display_name,
      role: req.body.role
    };
    const user = postgresEnabled ? await addUserPostgres(postgresPool(), input) : addUser(input);
    req.session.flash = { type: 'success', message: `Added ${user.display_name} with starting Mushybux.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});

app.post('/admin/update-user', requireAdmin, async (req, res) => {
  try {
    const input = {
      userId: req.body.user_id,
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.display_name,
      role: req.body.role
    };
    const user = postgresEnabled ? await updateUserDetailsPostgres(postgresPool(), input) : updateUserDetails(input);
    req.session.flash = { type: 'success', message: `Updated ${user.display_name}.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin');
});



app.post('/admin/odds/series', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    const input = {
      week: targetWeek,
      seriesKey: req.body.series_key,
      marketKeys: req.body.market_key || [],
      multipliers: req.body.multiplier || [],
      goalTotalLine: req.body.goal_total_line,
      goalTotalBoost: req.body.goal_total_boost
    };
    if (postgresEnabled) await saveSeriesOddsForWeekPostgres(postgresPool(), input); else saveSeriesOddsForWeek(input);
    req.session.flash = { type: 'success', message: `Saved Week ${targetWeek} series odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#series-odds-recommendations');
});

app.post('/admin/odds/bulk-series', requireAdmin, async (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    const rows = JSON.parse(String(req.body.payload || '[]'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('No series odds were submitted.');
    for (const row of rows) {
      const input = {
        week: targetWeek,
        seriesKey: row.series_key,
        marketKeys: row.market_key || [],
        multipliers: row.multiplier || [],
        goalTotalLine: row.goal_total_line,
        goalTotalBoost: row.goal_total_boost
      };
      if (postgresEnabled) await saveSeriesOddsForWeekPostgres(postgresPool(), input); else saveSeriesOddsForWeek(input);
    }
    req.session.flash = { type: 'success', message: `Applied all displayed Week ${targetWeek} series odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  const current = Number(req.body.week) === Number((postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings()).currentWeek);
  res.redirect(`/admin?odds_week=${current ? 'current' : 'next'}#series-odds-recommendations`);
});

app.post('/admin/odds/apply-series-recommendations', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    const report = await buildSeriesOddsRecommendations({
      seasonId: settings.seasonId,
      targetWeek
    });
    for (const rec of report.recommendations) {
      const input = {
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
      };
      if (postgresEnabled) await saveSeriesOddsForWeekPostgres(postgresPool(), input); else saveSeriesOddsForWeek(input);
    }
    req.session.flash = { type: 'success', message: `Applied all Week ${targetWeek} series recommendations.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#series-odds-recommendations');
});

app.post('/admin/odds/series-prop', requireAdmin, async (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    const input = {
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
    };
    if (postgresEnabled) await saveSeriesPropForWeekPostgres(postgresPool(), input); else saveSeriesPropForWeek(input);
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
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    const markets = await buildWeeklyPropMarkets({
      seasonId: settings.seasonId,
      week: targetWeek,
      odds: { seriesProps: {} }
    });
    const input = {
      week: targetWeek,
      markets: markets.map(market => ({
        ...market,
        enabled: market.eligibility === 'automatic'
      }))
    };
    if (postgresEnabled) await saveSeriesPropsForWeekPostgres(postgresPool(), input); else saveSeriesPropsForWeek(input);
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
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
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
          const input = {
            week: targetWeek,
            divisionId,
            category,
            playerKey: player.playerKey,
            multiplier: player.recommendedOdds
          };
          if (postgresEnabled) await savePropPlayerOverrideForWeekPostgres(postgresPool(), input); else savePropPlayerOverrideForWeek(input);
        }
      }
    }
    req.session.flash = { type: 'success', message: `Applied Week ${targetWeek} Top Scorer and Top Goalie recommendations.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#leader-prop-recommendations');
});

app.post('/admin/odds/bulk-leader-props', requireAdmin, async (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    const rows = JSON.parse(String(req.body.payload || '[]'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('No leader prop odds were submitted.');
    for (const row of rows) {
      const input = {
        week: targetWeek,
        divisionId: row.division_id,
        category: row.category,
        playerKey: row.player_key,
        multiplier: row.multiplier
      };
      if (postgresEnabled) await savePropPlayerOverrideForWeekPostgres(postgresPool(), input); else savePropPlayerOverrideForWeek(input);
    }
    req.session.flash = { type: 'success', message: `Applied all displayed Week ${targetWeek} Top Scorer and Top Goalie odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  const current = Number(req.body.week) === Number((postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings()).currentWeek);
  res.redirect(`/admin?odds_week=${current ? 'current' : 'next'}#leader-prop-recommendations`);
});

app.post('/admin/odds/bulk-player-props', requireAdmin, async (req, res) => {
  try {
    const targetWeek = Number(req.body.week);
    const rows = JSON.parse(String(req.body.payload || '[]'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('No player props were submitted.');
    const input = {
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
    };
    if (postgresEnabled) await saveSeriesPropsForWeekPostgres(postgresPool(), input); else saveSeriesPropsForWeek(input);
    req.session.flash = { type: 'success', message: `Applied all displayed Week ${targetWeek} player props.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  const current = Number(req.body.week) === Number((postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings()).currentWeek);
  res.redirect(`/admin?odds_week=${current ? 'current' : 'next'}#prop-odds-recommendations`);
});

app.post('/admin/odds/prop-default', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    const input = {
      week: targetWeek,
      divisionId: req.body.division_id,
      category: req.body.category,
      multiplier: req.body.multiplier,
      quantity1: req.body.quantity_1,
      quantity2: req.body.quantity_2,
      quantity3: req.body.quantity_3
    };
    if (postgresEnabled) await savePropDefaultOddsForWeekPostgres(postgresPool(), input); else savePropDefaultOddsForWeek(input);
    req.session.flash = { type: 'success', message: `Saved Week ${targetWeek} prop odds.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin#prop-odds-recommendations');
});

app.post('/admin/odds/player-override', requireAdmin, async (req, res) => {
  try {
    const settings = postgresEnabled ? await getAdminSettingsPostgres(postgresPool()) : getAdminSettings();
    const targetWeek = Number(req.body.week || Number(settings.currentWeek) + 1);
    if (String(req.body.clear || '') === '1') {
      const input = {
        week: targetWeek,
        divisionId: req.body.division_id,
        category: req.body.category,
        playerKey: req.body.player_key
      };
      if (postgresEnabled) await clearPropPlayerOverrideForWeekPostgres(postgresPool(), input); else clearPropPlayerOverrideForWeek(input);
      req.session.flash = { type: 'success', message: `Cleared Week ${targetWeek} player odds override.` };
    } else {
      const category = String(req.body.category || '');
      if (category === 'hat_trick' || category === 'shutout') {
        for (const q of [1, 2, 3]) {
          const value = req.body[`quantity_${q}`];
          if (String(value ?? '').trim()) {
            const input = {
              week: targetWeek,
              divisionId: req.body.division_id,
              category,
              playerKey: req.body.player_key,
              multiplier: value,
              quantity: q
            };
            if (postgresEnabled) await savePropPlayerOverrideForWeekPostgres(postgresPool(), input); else savePropPlayerOverrideForWeek(input);
          }
        }
      } else {
        const input = {
          week: targetWeek,
          divisionId: req.body.division_id,
          category,
          playerKey: req.body.player_key,
          multiplier: req.body.multiplier
        };
        if (postgresEnabled) await savePropPlayerOverrideForWeekPostgres(postgresPool(), input); else savePropPlayerOverrideForWeek(input);
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
