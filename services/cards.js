import {
  getBettingDivisions,
  getBoxscores,
  getDivisions,
  getPlayers,
  getSchedule,
  getTeams,
  getUpcomingSeries
} from './wcplData.js';
import fs from 'fs/promises';
import path from 'path';
import { readCsvFile } from './csv.js';

export const CARD_TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
export const CARD_STARS = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6 };
// WUT 2.0 uses immutable match snapshots, so owned cards never need cooldowns.
export const CARD_COOLDOWNS = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 };
export const BOOST_TYPES = ['goal', 'assist', 'shot', 'grit', 'save', 'shutout'];
export const DEFAULT_BOOST_EFFECTS = {
  goal: { common: { per: 1, bonus: 2 }, uncommon: { per: 1, bonus: 3 }, rare: { per: 1, bonus: 5 }, epic: { per: 1, bonus: 7 }, legendary: { per: 1, bonus: 10 } },
  assist: { common: { per: 1, bonus: 1 }, uncommon: { per: 1, bonus: 2 }, rare: { per: 1, bonus: 3 }, epic: { per: 1, bonus: 5 }, legendary: { per: 1, bonus: 7 } },
  shot: { common: { per: 4, bonus: 1 }, uncommon: { per: 3, bonus: 1 }, rare: { per: 2, bonus: 1 }, epic: { per: 1, bonus: 1 }, legendary: { per: 1, bonus: 2 } },
  grit: { common: { per: 1, bonus: 1 }, uncommon: { per: 1, bonus: 2 }, rare: { per: 1, bonus: 3 }, epic: { per: 1, bonus: 5 }, legendary: { per: 1, bonus: 7 } },
  hit: { common: { per: 1, bonus: 1 }, uncommon: { per: 1, bonus: 2 }, rare: { per: 1, bonus: 3 }, epic: { per: 1, bonus: 4 }, legendary: { per: 1, bonus: 6 } },
  block: { common: { per: 1, bonus: 2 }, uncommon: { per: 1, bonus: 3 }, rare: { per: 1, bonus: 4 }, epic: { per: 1, bonus: 6 }, legendary: { per: 1, bonus: 8 } },
  save: { common: { per: 8, bonus: 1 }, uncommon: { per: 5, bonus: 1 }, rare: { per: 3, bonus: 1 }, epic: { per: 2, bonus: 1 }, legendary: { per: 1, bonus: 1 } },
  shutout: { common: { per: 1, bonus: 5 }, uncommon: { per: 1, bonus: 10 }, rare: { per: 1, bonus: 15 }, epic: { per: 1, bonus: 25 }, legendary: { per: 1, bonus: 40 } }
};
export const DEFAULT_STAT_POINTS = {
  goal: 10,
  assist: 7,
  shot: 1,
  hit: 3,
  block: 4,
  save: 2,
  shutout: 10
};
export const DEFAULT_SAVE_PCT_BONUSES = [
  { threshold: 0, multiplier: 0.85 },
  { threshold: 0.85, multiplier: 1 },
  { threshold: 0.9, multiplier: 1.1 },
  { threshold: 0.925, multiplier: 1.2 },
  { threshold: 0.95, multiplier: 1.35 },
  { threshold: 0.975, multiplier: 1.5 }
];
export const DEFAULT_CHEMISTRY_BONUSES = { 2: 10, 3: 15, 4: 20, 5: 25 };
export const PLAYER_CARD_SEASONS = ['S1', 'S2', 'S3'];
export const HISTORICAL_SAMPLE_SIZE = 3;
const S1_GOALIE_SAVE_PCT_MAX_DEVIATION = 0.05;
const S1_GOALIE_SHOTS_MIN_FACTOR = 0.5;
const S1_GOALIE_SHOTS_MAX_FACTOR = 1.5;
const PACK_EXCLUDED_PLAYER_NAMES = new Set(['bleh', 'jurkey']);
const PACK_EXCLUDED_STEAM_IDS = new Set(['76561198300298208', '76561199027789459']);
export const S1_CANONICAL_POSITIONS = Object.freeze({
  'nickisntcool': 'F', 'bardownbart': 'D', 'boeser': 'F', 'lepuckuer': 'D',
  'imacomputa': 'D', 'jarry': 'G', 'jb': 'D', 'quick': 'G',
  'moose': 'F', 'foxbrow': 'F', 'pogba': 'D', 'poro': 'F', 'pretty': 'D',
  'rickey': 'G', 'walker': 'D', 'player 43': 'F', 'foster': 'G',
  'nakamura': 'G', 'john puck': 'F', 'mushy': 'D', 'pyros': 'F',
  'supawoov': 'D', 'matvei': 'F', 'light': 'G', 'puckster': 'G',
  'stinkyshawn': 'F', 'chilliam': 'D', 'silly': 'D', 'zen': 'G',
  'jurkey': 'F', 'dabz': 'D', 'ovo': 'F', 'siddedon': 'D', 'marcus': 'F',
  'midnight': 'F', 'milk': 'G', 'socanadian': 'F', 'miku': 'G',
  'nemestokes': 'D', 'shoe': 'D'
});

export const DEFAULT_CARDS_CONFIG = {
  playerPackPrices: { standard: 250, premium: 500, prestige: 1000 },
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
  boostEffects: DEFAULT_BOOST_EFFECTS,
  scoring: {
    statPoints: DEFAULT_STAT_POINTS,
    savePctBonuses: DEFAULT_SAVE_PCT_BONUSES,
    chemistryBonuses: DEFAULT_CHEMISTRY_BONUSES
  }
};

const MYTHIC_CARDS_PATH = path.resolve(process.env.MYTHIC_CARDS_PATH || './data/cards_mythic.json');

function clean(value) {
  return String(value ?? '').trim();
}

function norm(value) {
  return clean(value).toLowerCase();
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function randomPoisson(lambda) {
  const rate = Math.max(0, Number(lambda || 0));
  if (rate <= 0) return 0;
  const limit = Math.exp(-rate);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= Math.random();
  } while (product > limit);
  return count - 1;
}

function randomCenteredDeviation(maxDeviation) {
  const centered = (Math.random() + Math.random() + Math.random() + Math.random()) / 4;
  return (centered - 0.5) * 2 * maxDeviation;
}

function capSyntheticGoalieSavePct(rows, historicalSavePct) {
  const adjustableRows = rows.filter(row => n(row.so) < 1);
  const shotsAgainst = adjustableRows.reduce((sum, row) => sum + n(row.sa), 0);
  if (shotsAgainst <= 0) return rows;
  const lower = clamp(historicalSavePct - S1_GOALIE_SAVE_PCT_MAX_DEVIATION, 0, 1);
  const upper = clamp(historicalSavePct + S1_GOALIE_SAVE_PCT_MAX_DEVIATION, 0, 1);
  const maximumNonShutoutSaves = shotsAgainst - adjustableRows.filter(row => n(row.sa) > 0).length;
  const maximumSaves = Math.min(maximumNonShutoutSaves, Math.floor(shotsAgainst * upper));
  const minimumSaves = Math.min(maximumSaves, Math.ceil(shotsAgainst * lower));
  const currentGoals = adjustableRows.reduce((sum, row) => sum + n(row.ga), 0);
  const currentSaves = shotsAgainst - currentGoals;
  const targetSaves = Math.min(maximumSaves, Math.max(minimumSaves, currentSaves));
  let goalsAdjustment = shotsAgainst - targetSaves - currentGoals;
  let cursor = 0;
  while (goalsAdjustment !== 0) {
    const candidates = goalsAdjustment > 0
      ? adjustableRows.filter(row => n(row.ga) < n(row.sa))
      : adjustableRows.filter(row => n(row.ga) > (n(row.sa) > 0 ? 1 : 0));
    if (!candidates.length) break;
    const row = candidates[cursor % candidates.length];
    row.ga = n(row.ga) + (goalsAdjustment > 0 ? 1 : -1);
    goalsAdjustment += goalsAdjustment > 0 ? -1 : 1;
    cursor += 1;
  }
  return rows;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, n(value)));
}

function positionGroup(position) {
  const value = clean(position).toUpperCase();
  if (value === 'G') return 'G';
  if (['LD', 'RD', 'D'].includes(value)) return 'D';
  if (['C', 'LW', 'RW', 'F', 'S'].includes(value)) return 'F';
  return '';
}

function normalizeSeason(season) {
  const value = clean(season).toUpperCase();
  return PLAYER_CARD_SEASONS.includes(value) ? value : 'S3';
}

function cardCatalogKey({ season, divisionId, playerKey, cardType = 'player', mythicId = '' }) {
  if (cardType === 'mythic') return `MYTHIC|${clean(mythicId || playerKey)}`;
  return `${normalizeSeason(season)}|${clean(divisionId)}|${clean(playerKey)}`;
}

function indexes(rows, nameField = 'name') {
  const bySteam = new Map();
  const byKey = new Map();
  const byName = new Map();
  for (const row of rows || []) {
    if (norm(row.steam_id)) bySteam.set(norm(row.steam_id), row);
    if (norm(row.player_key)) byKey.set(norm(row.player_key), row);
    if (norm(row[nameField])) byName.set(norm(row[nameField]), row);
  }
  return { bySteam, byKey, byName };
}

function findIdentity(player, idx, nameField = 'name') {
  return idx.bySteam.get(norm(player.steam_id)) ||
    idx.byKey.get(norm(player.player_key)) ||
    idx.byName.get(norm(player[nameField] || player.display_name || player.name)) ||
    null;
}

function countPositions(player, boxscores) {
  const out = { F: 0, D: 0, G: 0 };
  const steam = norm(player.steam_id);
  const name = norm(player.display_name || player.name);
  for (const row of boxscores || []) {
    const matches = (steam && norm(row.steam_id) === steam) ||
      (!steam && norm(row.player_name) === name);
    if (!matches) continue;
    const group = positionGroup(row.position);
    if (group) out[group] += 1;
  }
  return out;
}

function resolveCountWinner(counts) {
  const max = Math.max(...Object.values(counts));
  if (max <= 0) return '';
  const winners = Object.entries(counts).filter(([, value]) => value === max);
  return winners.length === 1 ? winners[0][0] : '';
}

export function normalizeFantasyScoringConfig(scoringConfig = {}) {
  const statPoints = Object.fromEntries(Object.entries(DEFAULT_STAT_POINTS).map(([key, fallback]) => {
    const configured = Number(scoringConfig?.statPoints?.[key]);
    return [key, Number.isFinite(configured) && configured >= 0 ? configured : fallback];
  }));
  const configuredSavePct = Array.isArray(scoringConfig?.savePctBonuses)
    ? scoringConfig.savePctBonuses
    : DEFAULT_SAVE_PCT_BONUSES;
  const savePctBonuses = configuredSavePct.map((row, index) => {
    const threshold = Number(row?.threshold);
    const multiplier = Number(row?.multiplier);
    return {
      threshold: Number.isFinite(threshold) ? threshold : DEFAULT_SAVE_PCT_BONUSES[index]?.threshold || 0,
      multiplier: Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : DEFAULT_SAVE_PCT_BONUSES[index]?.multiplier || 1
    };
  }).sort((a, b) => a.threshold - b.threshold);
  return {
    statPoints,
    savePctBonuses: savePctBonuses.length ? savePctBonuses : DEFAULT_SAVE_PCT_BONUSES.map(row => ({ ...row })),
    chemistryBonuses: { ...DEFAULT_CHEMISTRY_BONUSES, ...(scoringConfig?.chemistryBonuses || {}) }
  };
}

export function chemistryMultiplierForCount(count, scoringConfig = {}) {
  const scoring = normalizeFantasyScoringConfig(scoringConfig);
  const bracket = Number(count) >= 5 ? 5 : Number(count);
  const percent = bracket >= 2 ? Number(scoring.chemistryBonuses[String(bracket)] || 0) : 0;
  return 1 + Math.max(0, percent) / 100;
}

export function captainPatchChemistry(baseMultiplier, patchEffects = []) {
  const strongest = Math.max(0, ...(patchEffects || []).map(Number).filter(Number.isFinite));
  const baseBonus = Math.max(0, Number(baseMultiplier || 1) - 1);
  return { multiplier: 1 + baseBonus * (1 + strongest), effect: strongest };
}

export function wutChemistryKey(player = {}) {
  const teamId = clean(player.teamId || player.team_id).toUpperCase();
  if (!teamId) return '';
  const cardType = norm(player.cardType || player.card_type);
  const season = normalizeSeason(cardType === 'mythic'
    ? player.sourceSeason || player.source_season || player.season
    : player.edition || player.season || player.sourceSeason || player.source_season);
  return `${season}|${teamId}`;
}

export function applyChemistryBonus(score, chemistry) {
  const multiplier = Number(chemistry?.multiplier || 1);
  if (!score || multiplier <= 1) return score;
  const exactBefore = Number(score.exactFp ?? score.fp ?? 0);
  const bonus = exactBefore * (multiplier - 1);
  const pct = Number(((multiplier - 1) * 100).toFixed(2));
  return {
    ...score,
    exactFp: exactBefore + bonus,
    fp: Math.round(exactBefore + bonus),
    breakdown: [
      ...(score.breakdown || []),
      {
        type: 'chemistry_bonus',
        label: `Chemistry bonus (+${pct}%)`,
        count: null,
        basePoints: bonus,
        points: bonus,
        boosted: false,
        multiplier,
        teamCount: Number(chemistry?.count || 0)
      }
    ]
  };
}

// WUT trinket scoring is split into two pure phases so balance changes can be
// tested without creating a live match. This phase only changes the owner's
// positive score and runs before boosts and chemistry.
export function applyWutSelfTrinket({
  exactFp = 0,
  trinket = null,
  gameFps = [],
  bonusGameFps = [],
  breakdown = [],
  stats = {},
  isFirst = false,
  hasOpponent = false,
  teamCount = 0,
  cardRarityRank = 1,
  opponentRarityRank = null
} = {}) {
  let exact = Number(exactFp || 0);
  const startingExact = exact;
  const logs = [];
  const family = trinket?.family;
  const effect = trinket?.effect;
  const games = [...gameFps].map(Number).filter(Number.isFinite);
  let trinketLabel = '';
  let luckyCharm = null;

  if (family === 'lucky_charm' && games.length) {
    trinketLabel = 'Lucky Charm';
    const candidates = [...bonusGameFps].slice(0, Number(effect?.rolls || 1)).map(Number).filter(Number.isFinite);
    const best = Math.max(...candidates, -Infinity);
    const highest = Math.max(...games);
    const threshold = Number(effect?.threshold || 1);
    const qualifies = threshold > 1 ? best >= highest * threshold : best > highest;
    const low = games.indexOf(Math.min(...games));
    luckyCharm = { hit: qualifies, replacedIndex: qualifies ? low : null, usedBonusIndex: qualifies ? candidates.indexOf(best) : null };
    if (qualifies) {
      exact += best - games[low];
      logs.push(`Lucky Charm replaced ${games[low].toFixed(1)} with ${best.toFixed(1)} FP.`);
    } else logs.push('Lucky Charm did not clear its spike threshold.');
  } else if (family === 'safety_net' && games.length >= 3) {
    trinketLabel = 'Safety Net';
    const low = games.indexOf(Math.min(...games));
    const others = games.filter((_, index) => index !== low);
    const floor = others.reduce((sum, value) => sum + value, 0) / others.length * Number(effect || 0);
    if (games[low] < floor) {
      exact += floor - games[low];
      logs.push(`Safety Net raised the floor by ${(floor - games[low]).toFixed(1)} FP.`);
    }
  } else if (family === 'glass_skates' && games.length) {
    trinketLabel = 'Glass Skates';
    let delta = 0;
    if (Array.isArray(effect)) {
      // Legacy WUT 2.0 effect shape, retained so old saved matches remain
      // replayable while the launch balance lab evaluates the glass-cannon rule.
      delta = Math.max(...games) * Number(effect?.[0] || 0) + Math.min(...games) * Number(effect?.[1] || 0);
    } else {
      const ordered = [...games].sort((a, b) => b - a);
      const threshold = Math.max(0, Number(effect?.threshold || 0));
      const cleared = ordered.length >= 2 && ordered[0] >= ordered[1] * (1 + threshold);
      const rate = cleared ? Number(effect?.bonus || 0) : -Math.abs(Number(effect?.penalty || 0));
      delta = startingExact * rate;
      trinketLabel = cleared ? 'Glass Skates (boom)' : 'Glass Skates (bust)';
    }
    exact += delta;
    logs.push(`Glass Skates ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} FP.`);
  } else if (family === 'specialist_tape') {
    const stat = [...breakdown].filter(row => !row?.unavailable).sort((a, b) => Number(b.points || 0) - Number(a.points || 0))[0];
    trinketLabel = `Specialist (${stat?.label || 'top stat'})`;
    const gain = Number(stat?.points || 0) * Number(effect || 0);
    exact += gain;
    logs.push(`Specialist boosted ${stat?.label || 'top stat'} +${gain.toFixed(1)} FP.`);
  } else if (family === 'first_strike_tape' && isFirst) {
    trinketLabel = 'First Strike';
    const gain = exact * Number(effect || 0); exact += gain;
    logs.push(`First Strike +${gain.toFixed(1)} FP.`);
  } else if (family === 'counterpunch_gloves' && hasOpponent && !isFirst) {
    trinketLabel = 'Counterpunch Gloves';
    const gain = exact * Number(effect || 0); exact += gain;
    logs.push(`Counterpunch Gloves +${gain.toFixed(1)} FP.`);
  } else if (family === 'underdog_patch' && hasOpponent && Number(cardRarityRank) < Number(opponentRarityRank)) {
    trinketLabel = 'Underdog Patch';
    const gap = Number(opponentRarityRank) - Number(cardRarityRank);
    const pct = Math.min(Number(effect?.[1] || 0), gap * Number(effect?.[0] || 0));
    const gain = exact * pct; exact += gain;
    logs.push(`Underdog Patch +${gain.toFixed(1)} FP (${gap}-tier card-rarity gap).`);
  } else if (family === 'generalist') {
    const categories = ['goals', 'assists', 'shots', 'hits', 'blocks'];
    const combo = categories.filter(key => Number(stats?.[key] || 0) > 0).length;
    const rate = Number(effect?.[String(combo)] ?? effect?.[combo] ?? 0);
    trinketLabel = `Generalist (${combo}-stat combo)`;
    if (combo >= 3 && rate > 0) {
      const gain = exact * rate;
      exact += gain;
      logs.push(`Generalist ${combo}-stat combo +${gain.toFixed(1)} FP.`);
    }
  }
  return { exactFp: exact, logs, trinketGain: exact - startingExact, trinketLabel, luckyCharm };
}

// Positive layer order is a game rule, not an implementation detail:
// self trinket -> committed boost -> chemistry -> would-be final FP.
export function applyWutPositiveScoring({
  baseExactFp = 0,
  trinket = null,
  gameFps = [],
  bonusGameFps = [],
  breakdown = [],
  isFirst = false,
  hasOpponent = false,
  teamCount = 0,
  cardRarityRank = 1,
  opponentRarityRank = null,
  stats = {},
  boost = null,
  boostLoad = 0,
  adjacentBoostGains = [],
  chemistryMultiplier = 1
} = {}) {
  const self = applyWutSelfTrinket({ exactFp: baseExactFp, trinket, gameFps, bonusGameFps, breakdown, isFirst, hasOpponent, teamCount, cardRarityRank, opponentRarityRank, stats });
  const logs = [...self.logs];
  const boostGain = boostFantasyBonus(stats, boost);
  let cableGain = 0;
  if (trinket?.family === 'booster_cable') {
    cableGain += boostGain * Math.max(0, Number(trinket.effect?.own || 0));
    const adjacent = (adjacentBoostGains || []).map(Number).filter(value => Number.isFinite(value) && value > 0);
    const eligible = trinket.effect?.adjacentMode === 'strongest'
      ? adjacent.sort((a, b) => b - a).slice(0, 1)
      : adjacent;
    cableGain += eligible.reduce((sum, value) => sum + value, 0) * Math.max(0, Number(trinket.effect?.adjacent || 0));
    if (cableGain) logs.push(`Booster Cable +${cableGain.toFixed(1)} FP from committed boosts.`);
  }
  let exact = self.exactFp + boostGain + cableGain;
  if (boostGain) logs.push(`${boost.boost_type || boost.boostType} Boost +${boostGain.toFixed(1)} FP (${Number(boostLoad || 0)} Load).`);
  const multiplier = Math.max(1, Number(chemistryMultiplier || 1));
  const chemistryGain = exact * (multiplier - 1);
  exact *= multiplier;
  if (chemistryGain) logs.push(`Chemistry +${chemistryGain.toFixed(1)} FP.`);
  return {
    wouldBeFp: exact,
    selfFp: self.exactFp,
    boostGain,
    cableGain,
    chemistryGain,
    trinketGain: self.trinketGain + cableGain,
    trinketLabel: self.trinketLabel || (cableGain ? 'Booster Cable' : ''),
    preChemistryFp: self.exactFp + boostGain + cableGain,
    luckyCharm: self.luckyCharm,
    logs
  };
}

// Hostile trinkets always read wouldBeFp, which already includes the owner's
// self trinket, boost, and chemistry. They never read another hostile result,
// preventing circular Hex/Siphon resolution. Warding reduces incoming strength.
export function resolveWutMatchingTrinkets(entries = []) {
  const resolved = entries.map(entry => ({
    ...entry,
    finalFp: Number(entry.finalFp ?? entry.wouldBeFp ?? 0),
    logs: [...(entry.logs || [])],
    scoringEffects: [...(entry.scoringEffects || [])]
  }));
  for (const source of resolved) {
    const target = resolved.find(other => Number(other.placement?.user_id) !== Number(source.placement?.user_id) && other.placement?.slot === source.placement?.slot);
    if (!target) continue;
    const ward = target.trinket?.family === 'warding_charm' ? Number(target.trinket.effect || 0) : 0;
    if (source.trinket?.family === 'hex_bag') {
      const [threshold, reduction] = source.trinket.effect || [];
      if (Number(target.wouldBeFp) >= Number(threshold) * Math.max(Number(source.wouldBeFp), 10)) {
        const rawLoss = Number(target.wouldBeFp) * Number(reduction);
        const blocked = rawLoss * ward;
        const loss = rawLoss - blocked;
        target.finalFp -= loss;
        source.logs.push(`Hex Charm reduced opposing ${source.placement.slot} by ${loss.toFixed(1)} FP${ward ? ' after Warding' : ''}.`);
        target.logs.push(`Incoming Hex Charm -${loss.toFixed(1)} FP.`);
        source.scoringEffects.push({ type: 'trinket', family: 'hex_bag', direction: 'outgoing', triggered: true, label: 'Hex Charm triggered', points: 0, rarity: source.trinket?.rarity || 'common' });
        target.scoringEffects.push({ type: 'trinket', family: 'hex_bag', direction: 'incoming', triggered: true, label: 'Incoming Hex Charm', points: -rawLoss, rarity: source.trinket?.rarity || 'common' });
        if (blocked) target.scoringEffects.push({ type: 'trinket', family: 'warding_charm', direction: 'defense', triggered: true, label: 'Warding Charm blocked Hex', points: blocked, rarity: target.trinket?.rarity || 'common' });
      }
    }
    if (source.trinket?.family === 'siphon_stone' && Number(target.wouldBeFp) > Number(source.wouldBeFp)) {
      const rawSteal = (Number(target.wouldBeFp) - Number(source.wouldBeFp)) * Number(source.trinket.effect || 0);
      const blocked = rawSteal * ward;
      const steal = rawSteal - blocked;
      source.finalFp += steal;
      target.finalFp -= steal;
      source.logs.push(`Siphon Stone stole ${steal.toFixed(1)} FP${ward ? ' after Warding' : ''}.`);
      target.logs.push(`Incoming Siphon -${steal.toFixed(1)} FP.`);
      source.scoringEffects.push({ type: 'trinket', family: 'siphon_stone', direction: 'outgoing', triggered: true, label: 'Siphon Stone', points: steal, rarity: source.trinket?.rarity || 'common' });
      target.scoringEffects.push({ type: 'trinket', family: 'siphon_stone', direction: 'incoming', triggered: true, label: 'Incoming Siphon Stone', points: -rawSteal, rarity: source.trinket?.rarity || 'common' });
      if (blocked) target.scoringEffects.push({ type: 'trinket', family: 'warding_charm', direction: 'defense', triggered: true, label: 'Warding Charm blocked Siphon', points: blocked, rarity: target.trinket?.rarity || 'common' });
    }
  }
  return resolved;
}

function saveMultiplier(savePct, scoringConfig = {}) {
  const rows = normalizeFantasyScoringConfig(scoringConfig).savePctBonuses;
  let multiplier = Number(rows[0]?.multiplier ?? 1);
  for (const row of rows) {
    if (savePct < Number(row.threshold)) break;
    multiplier = Number(row.multiplier);
  }
  return multiplier;
}

export function fantasyPointsForRows(rows, position, scoringConfig = {}) {
  const scoring = normalizeFantasyScoringConfig(scoringConfig);
  const group = positionGroup(position);
  if (group === 'G') {
    const shotsAgainst = rows.reduce((sum, row) => sum + n(row.sa), 0);
    const goalsAgainst = rows.reduce((sum, row) => sum + n(row.ga), 0);
    const saves = Math.max(0, shotsAgainst - goalsAgainst);
    const savePct = shotsAgainst > 0 ? saves / shotsAgainst : 0;
    const shutouts = rows.reduce(
      (sum, row) => sum + (n(row.so) >= 1 || (n(row.sa) > 0 && n(row.ga) === 0) ? 1 : 0),
      0
    );
    return {
      exact: saves * scoring.statPoints.save * saveMultiplier(savePct, scoring) + shutouts * scoring.statPoints.shutout,
      stats: { saves, shotsAgainst, goalsAgainst, savePct, shutouts }
    };
  }
  const stats = rows.reduce((out, row) => {
    out.goals += n(row.g);
    out.assists += n(row.a);
    out.shots += n(row.shots);
    out.hits += n(row.hits);
    out.blocks += n(row.blocks);
    return out;
  }, { goals: 0, assists: 0, shots: 0, hits: 0, blocks: 0 });
  return {
    exact: stats.goals * scoring.statPoints.goal +
      stats.assists * scoring.statPoints.assist +
      stats.shots * scoring.statPoints.shot +
      stats.hits * scoring.statPoints.hit +
      stats.blocks * scoring.statPoints.block,
    stats
  };
}

export function boostFantasyBonus(stats, boost) {
  const type = clean(boost?.boost_type || boost?.boostType).toLowerCase();
  const rarity = clean(boost?.rarity).toLowerCase();
  if (!type || !rarity) return 0;
  const effect = boost?.effect || DEFAULT_BOOST_EFFECTS[type]?.[rarity];
  if (!effect) return 0;
  const per = Math.max(1, Number(effect.per || 1));
  if (type === 'grit') {
    return (Math.floor(n(stats?.hits) / per) + Math.floor(n(stats?.blocks) / per)) * Number(effect.bonus || 0);
  }
  const statKey = { goal: 'goals', assist: 'assists', shot: 'shots', hit: 'hits', block: 'blocks', save: 'saves', shutout: 'shutouts' }[type];
  return Math.floor(n(stats?.[statKey]) / per) * Number(effect.bonus || 0);
}

export function applyBoostToFantasy(result, boost, { unavailableStats = [] } = {}) {
  const type = clean(boost?.boost_type || boost?.boostType).toLowerCase();
  if (!type || unavailableStats.includes(type)) return result.exact;
  return result.exact + boostFantasyBonus(result.stats, boost);
}

export function buildFantasyBreakdown(stats, position, boost = null, options = {}) {
  const scoring = normalizeFantasyScoringConfig(options.scoringConfig || {});
  const group = positionGroup(position);
  const boostedType = clean(boost?.boost_type).toLowerCase();
  const boostBonus = boostFantasyBonus(stats, boost);
  const unavailableStats = new Set((options.unavailableStats || []).map(item => clean(item).toLowerCase()));
  const omitUnavailable = options.omitUnavailable === true;
  if (group === 'G') {
    const savePct = n(stats.savePct);
    const saves = n(stats.saves);
    const savesBasePoints = saves * scoring.statPoints.save;
    const savePctMultiplier = saveMultiplier(savePct, scoring);
    const savePctBonus = savesBasePoints * (savePctMultiplier - 1);
    return [
      {
        type: 'save',
        label: 'Saves',
        count: saves,
        basePoints: savesBasePoints,
        boostBonus: boostedType === 'save' ? boostBonus : 0,
        points: savesBasePoints + (boostedType === 'save' ? boostBonus : 0),
        boosted: boostedType === 'save',
        multiplier: 1
      },
      {
        type: 'save_pct',
        label: 'Save%',
        count: savePct.toFixed(3),
        basePoints: savePctBonus,
        boostBonus: 0,
        points: savePctBonus,
        boosted: false,
        multiplier: savePctMultiplier
      },
      {
        type: 'shutout',
        label: 'Shutouts',
        count: n(stats.shutouts),
        basePoints: n(stats.shutouts) * scoring.statPoints.shutout,
        boostBonus: boostedType === 'shutout' ? boostBonus : 0,
        points: n(stats.shutouts) * scoring.statPoints.shutout + (boostedType === 'shutout' ? boostBonus : 0),
        boosted: boostedType === 'shutout',
        multiplier: 1
      }
    ];
  }
  const definitions = [
    ['goal', 'G', 'goals', scoring.statPoints.goal],
    ['assist', 'A', 'assists', scoring.statPoints.assist],
    ['hit', 'HIT', 'hits', scoring.statPoints.hit],
    ['block', 'BLK', 'blocks', scoring.statPoints.block],
    ['shot', 'SH', 'shots', scoring.statPoints.shot]
  ];
  return definitions.flatMap(([type, label, key, value]) => {
    if (unavailableStats.has(type)) {
      if (omitUnavailable) return [];
      return {
        type,
        label,
        count: null,
        points: 0,
        boosted: false,
        multiplier: 1,
        unavailable: true
      };
    }
    const boosted = boostedType === type || (boostedType === 'grit' && ['hit', 'block'].includes(type));
    const lineBoostBonus = boostedType === 'grit' && ['hit', 'block'].includes(type)
      ? Math.floor(n(stats[key]) / Math.max(1, Number(boost?.effect?.per || 1))) * Number(boost?.effect?.bonus || 0)
      : boosted ? boostBonus : 0;
    return [{
      type,
      label,
      count: n(stats[key]),
      basePoints: n(stats[key]) * value,
      boostBonus: lineBoostBonus,
      points: n(stats[key]) * value + lineBoostBonus,
      boosted,
      multiplier: 1
    }];
  });
}

function aggregatePlayerRate(player, rows, position, scoringConfig = {}) {
  const steam = norm(player.steam_id);
  const name = norm(player.display_name || player.name);

  const wantGoalie = position === 'G';

  const matches = (rows || []).filter(row => {
    const samePlayer =
      (steam && norm(row.steam_id) === steam) ||
      (!steam && norm(row.player_name) === name);

    if (!samePlayer) return false;

    const rowPos = positionGroup(row.position);

    // For card purposes, F/D are both skater appearances.
    // The card's resolved position controls lineup slot,
    // but fantasy scoring should include all skater games.
    if (wantGoalie) return rowPos === 'G';
    return rowPos !== 'G';
  });

  if (!matches.length) return { games: 0, fp: 0, fpPerGame: 0 };

  const scoringPosition = wantGoalie ? 'G' : 'F';
  const result = fantasyPointsForRows(matches, scoringPosition, scoringConfig);

  return {
    games: matches.length,
    fp: result.exact,
    fpPerGame: result.exact / matches.length
  };
}

function aggregatePlayerRateFromSeasonRow(player, position, scoringConfig = {}) {
  const scoring = normalizeFantasyScoringConfig(scoringConfig);
  const displayStats = seasonDisplayStats(player, position);
  if (!displayStats?.games) return { games: 0, fp: 0, fpPerGame: 0 };
  if (position === 'G') {
    const stats = {
      saves: n(displayStats.saves),
      shotsAgainst: displayStats.savePct > 0 ? n(displayStats.saves) / n(displayStats.savePct) : 0,
      goalsAgainst: 0,
      savePct: n(displayStats.savePct),
      shutouts: n(displayStats.shutouts)
    };
    const exact = stats.saves * scoring.statPoints.save * saveMultiplier(stats.savePct, scoring) +
      stats.shutouts * scoring.statPoints.shutout;
    return { games: displayStats.games, fp: exact, fpPerGame: exact / displayStats.games };
  }
  const exact = n(displayStats.goals) * scoring.statPoints.goal +
    n(displayStats.assists) * scoring.statPoints.assist +
    n(displayStats.shots) * scoring.statPoints.shot +
    n(displayStats.hits) * scoring.statPoints.hit +
    n(displayStats.blocks) * scoring.statPoints.block;
  return { games: displayStats.games, fp: exact, fpPerGame: exact / displayStats.games };
}

function skaterHitBlockRateFromPlayer(player) {
  const games = n(player.gp_s);
  if (games <= 0) return null;
  return {
    hitsPerGame: n(player.hits) / games,
    blocksPerGame: n(player.blocks) / games
  };
}

function skaterHitBlockRateFromRows(player, rows) {
  const steam = norm(player.steam_id);
  const name = norm(player.display_name || player.name);
  const matches = (rows || []).filter(row =>
    ((steam && norm(row.steam_id) === steam) || (!steam && norm(row.player_name) === name)) &&
    positionGroup(row.position) !== 'G'
  );
  if (!matches.length) return null;
  return {
    hitsPerGame: matches.reduce((sum, row) => sum + n(row.hits), 0) / matches.length,
    blocksPerGame: matches.reduce((sum, row) => sum + n(row.blocks), 0) / matches.length
  };
}

async function buildS2SkaterHitBlockRates() {
  const divisions = await getDivisions('S2');
  const players = [];
  const boxes = [];
  for (const division of divisions) {
    const divisionId = division.division_id;
    const [divisionPlayers, divisionBoxes] = await Promise.all([
      getPlayers(divisionId, 'S2'),
      getBoxscores(divisionId, 'S2')
    ]);
    players.push(...divisionPlayers);
    boxes.push(...divisionBoxes);
  }

  const rates = [];
  const bySteam = new Map();
  const byKey = new Map();
  const byName = new Map();
  const skaterRows = boxes.filter(row => positionGroup(row.position) !== 'G');
  const league = skaterRows.length
    ? {
      hitsPerGame: skaterRows.reduce((sum, row) => sum + n(row.hits), 0) / skaterRows.length,
      blocksPerGame: skaterRows.reduce((sum, row) => sum + n(row.blocks), 0) / skaterRows.length
    }
    : { hitsPerGame: 0, blocksPerGame: 0 };

  for (const player of players) {
    if (positionGroup(player.position) === 'G') continue;
    const rate = skaterHitBlockRateFromPlayer(player) || skaterHitBlockRateFromRows(player, boxes);
    if (!rate) continue;
    rates.push(rate);
    if (norm(player.steam_id)) bySteam.set(norm(player.steam_id), rate);
    if (norm(player.player_key)) byKey.set(norm(player.player_key), rate);
    if (norm(player.display_name || player.name)) byName.set(norm(player.display_name || player.name), rate);
  }

  return {
    league: rates.length
      ? {
        hitsPerGame: rates.reduce((sum, rate) => sum + rate.hitsPerGame, 0) / rates.length,
        blocksPerGame: rates.reduce((sum, rate) => sum + rate.blocksPerGame, 0) / rates.length
      }
      : league,
    find(player) {
      return bySteam.get(norm(player.steam_id)) ||
        byKey.get(norm(player.player_key)) ||
        byName.get(norm(player.display_name || player.name)) ||
        null;
    }
  };
}

function seasonDisplayStats(row, position) {
  if (!row) return null;
  if (position === 'G') {
    const games = n(row.gp_g);
    const shotsAgainst = n(row.sa);
    const goalsAgainst = n(row.ga);
    const saves = Math.max(0, shotsAgainst - goalsAgainst);
    return {
      games,
      saves,
      shotsAgainst,
      goalsAgainst,
      savePct: shotsAgainst > 0 ? saves / shotsAgainst : n(row.sv_pct),
      shutouts: n(row.so)
    };
  }
  return {
    games: n(row.gp_s),
    goals: n(row.g),
    assists: n(row.a),
    shots: n(row.shots),
    hits: row.hits == null || row.hits === '' ? null : n(row.hits),
    blocks: row.blocks == null || row.blocks === '' ? null : n(row.blocks)
  };
}

function tierForRank(index, total) {
  const percentile = total ? index / total : 1;
  if (percentile < 0.05) return 'legendary';
  if (percentile < 0.15) return 'epic';
  if (percentile < 0.35) return 'rare';
  if (percentile < 0.70) return 'uncommon';
  return 'common';
}

export async function buildCardPlayerCatalog({
  seasonId = 'S3',
  positionOverrides = {},
  tierOverrides = {},
  scoringConfig = {}
} = {}) {
  const s3Divisions = await getBettingDivisions(seasonId);
  const catalog = [];
  const identitySeeds = [];
  const s2HitBlockRates = await buildS2SkaterHitBlockRates();

  for (const division of s3Divisions.filter(item => ['D1', 'D2'].includes(item.division_id))) {
    const divisionId = division.division_id;
    const [players, boxes] = await Promise.all([
      getPlayers(divisionId, seasonId),
      getBoxscores(divisionId, seasonId)
    ]);
    const teams = await getTeams(divisionId, seasonId);
    const teamsById = new Map(teams.map(team => [String(team.team_id || '').trim(), team]));
    for (const player of players) {
      const key = cardCatalogKey({ season: 'S3', divisionId, playerKey: player.player_key });
      const override = clean(positionOverrides[key]).toUpperCase();
      const s3Counts = countPositions(player, boxes);
      let resolvedPosition = override || resolveCountWinner(s3Counts);

      const rosterPosition = clean(player.position).toUpperCase();
      if (!resolvedPosition && rosterPosition === 'G') resolvedPosition = 'G';
      const s3 = resolvedPosition ? aggregatePlayerRate(player, boxes, resolvedPosition, scoringConfig) : { games: 0, fp: 0, fpPerGame: 0 };
      const seasonStats = { S3: seasonDisplayStats(player, resolvedPosition) };
      seasonStats.UT = seasonStats.S3;
      const team = teamsById.get(String(player.team_id || '').trim()) || {};
      const displayName = `S3 ${player.display_name}`;

      const card = {
        catalogKey: key,
        cardIdentity: key,
        card_type: 'player',
        cardType: 'player',
        edition: 'S3',
        season: 'S3',
        sourceSeason: seasonId,
        source_season: seasonId,
        sourceStage: 'reg',
        source_stage: 'reg',
        sourceTeamId: player.team_id,
        source_team_id: player.team_id,
        sourcePlayerKey: player.player_key,
        source_player_key: player.player_key,
        sourceSteamId: player.steam_id,
        source_steam_id: player.steam_id,
        displayName,
        divisionId,
        divisionName: division.division_name,
        playerKey: player.player_key,
        steamId: player.steam_id,
        baseName: player.display_name,
        name: displayName,
        teamId: player.team_id,
        teamName: clean(team.team_name || team.name) || player.team_id,
        position: resolvedPosition,
        positionNeedsReview: !resolvedPosition,
        positionCountsS3: s3Counts,
        positionCountsS2: { F: 0, D: 0, G: 0 },
        s2: { games: 0, fp: 0, fpPerGame: 0 },
        s3,
        seasonStats,
        editionStats: seasonStats.S3,
        weightedFpPerGame: s3.fpPerGame,
        rarityGamesPlayed: Number(s3.games || 0),
        tier: clean(tierOverrides[key]).toLowerCase() || 'common',
        stars: 1,
        teamLogo: `/images/casino/${divisionId}/${player.team_id}.png`,
        teamBgColor: clean(team.bg_color) || '#111520',
        teamTextColor: clean(team.text_color) || '#ffffff',
        unavailableStats: []
      };
      catalog.push(card);
      identitySeeds.push({ ...player, resolvedPosition, divisionId });
    }
  }

  const seedIndex = indexes(identitySeeds, 'display_name');
  for (const historicalSeason of ['S1', 'S2']) {
    const divisions = await getDivisions(historicalSeason);
    for (const division of divisions) {
      const divisionId = division.division_id;
      const [players, boxes, teams] = await Promise.all([
        getPlayers(divisionId, historicalSeason),
        getBoxscores(divisionId, historicalSeason),
        getTeams(divisionId, historicalSeason)
      ]);
      const teamsById = new Map(teams.map(team => [String(team.team_id || '').trim(), team]));
      for (const player of players) {
        const currentIdentity = findIdentity(player, seedIndex, 'display_name');
        const sourceDivisionId = clean(player.division_id) || currentIdentity?.divisionId || divisionId;
        const key = cardCatalogKey({ season: historicalSeason, divisionId: sourceDivisionId, playerKey: player.player_key });
        const override = clean(positionOverrides[key] || positionOverrides[`${sourceDivisionId}|${player.player_key}`]).toUpperCase();
        const counts = countPositions(player, boxes);
        const rosterPosition = clean(player.position).toUpperCase();
        const explicitHistoricalGoalie = rosterPosition === 'G' ? 'G' : '';
        const canonicalS1Position = historicalSeason === 'S1'
          ? S1_CANONICAL_POSITIONS[norm(player.display_name || player.name)] || ''
          : '';
        const resolvedPosition = override || canonicalS1Position || resolveCountWinner(counts) || explicitHistoricalGoalie || currentIdentity?.resolvedPosition || positionGroup(rosterPosition);
        const rate = resolvedPosition
          ? (boxes.length ? aggregatePlayerRate(player, boxes, resolvedPosition, scoringConfig) : aggregatePlayerRateFromSeasonRow(player, resolvedPosition, scoringConfig))
          : { games: 0, fp: 0, fpPerGame: 0 };
        if (rate.games < 8) continue;
        const stats = seasonDisplayStats(player, resolvedPosition);
        const s1SyntheticRates = historicalSeason === 'S1' && stats && resolvedPosition !== 'G'
          ? (s2HitBlockRates.find(player) || s2HitBlockRates.league)
          : null;
        if (s1SyntheticRates) {
          stats.hits = Math.round(n(s1SyntheticRates.hitsPerGame) * n(stats.games));
          stats.blocks = Math.round(n(s1SyntheticRates.blocksPerGame) * n(stats.games));
        }
        const scoring = normalizeFantasyScoringConfig(scoringConfig);
        const weightedFpPerGame = rate.fpPerGame + (s1SyntheticRates
          ? n(s1SyntheticRates.hitsPerGame) * scoring.statPoints.hit +
            n(s1SyntheticRates.blocksPerGame) * scoring.statPoints.block
          : 0);
      const team = teamsById.get(String(player.team_id || '').trim()) || {};
      const displayName = `${historicalSeason} ${player.display_name}`;
      catalog.push({
          catalogKey: key,
          cardIdentity: key,
          card_type: 'player',
          cardType: 'player',
          edition: historicalSeason,
          season: historicalSeason,
          sourceSeason: historicalSeason,
          source_season: historicalSeason,
          sourceStage: 'reg',
          source_stage: 'reg',
          sourceTeamId: player.team_id,
          source_team_id: player.team_id,
          sourcePlayerKey: player.player_key,
          source_player_key: player.player_key,
          sourceSteamId: player.steam_id,
          source_steam_id: player.steam_id,
          displayName,
          divisionId: sourceDivisionId,
          sourceDivisionId: divisionId,
          divisionName: division.division_name,
          playerKey: player.player_key,
          steamId: player.steam_id,
          baseName: player.display_name,
          name: displayName,
          teamId: player.team_id,
          teamName: clean(team.team_name || team.name) || player.team_id,
          position: resolvedPosition,
          positionNeedsReview: !resolvedPosition,
          positionCountsS3: { F: 0, D: 0, G: 0 },
          positionCountsS2: historicalSeason === 'S2' ? counts : { F: 0, D: 0, G: 0 },
          s2: historicalSeason === 'S2' ? rate : { games: 0, fp: 0, fpPerGame: 0 },
          s3: { games: 0, fp: 0, fpPerGame: 0 },
          seasonStats: { [historicalSeason]: stats, UT: stats },
          editionStats: stats,
          s1SyntheticRates,
          weightedFpPerGame,
          rarityGamesPlayed: Number(rate.games || 0),
          tier: clean(tierOverrides[key]).toLowerCase() || 'common',
          stars: 1,
          teamLogo: `/images/casino/${historicalSeason}/${player.team_id}.png`,
          teamBgColor: clean(team.bg_color) || '#111520',
          teamTextColor: clean(team.text_color) || '#ffffff',
          unavailableStats: []
        });
      }
    }
  }

  catalog.push(...await loadManualMythicCards());

  for (const player of catalog) {
    const rollCount = Number(player.scoringPool?.sampleSize || HISTORICAL_SAMPLE_SIZE);
    player.expectedWutFpPerMatch = Number(player.weightedFpPerGame || 0) * rollCount;
  }

  const pools = new Map();
  for (const player of catalog) {
    if (!player.position || player.cardType === 'mythic') continue;
    // Mature historical seasons share a pool; the live season stays isolated
    // so its small, volatile sample cannot displace established S1/S2 cards.
    // Every cohort remains position-specific.
    const seasonPool = normalizeSeason(player.edition) === 'S3' ? 'S3' : 'HISTORICAL';
    const poolKey = `${seasonPool}|${player.position}`;
    if (!pools.has(poolKey)) pools.set(poolKey, []);
    pools.get(poolKey).push(player);
  }
  for (const pool of pools.values()) {
    const eligible = pool
      .filter(player => Number(player.rarityGamesPlayed || 0) >= 6)
      .sort((a, b) => b.expectedWutFpPerMatch - a.expectedWutFpPerMatch || a.catalogKey.localeCompare(b.catalogKey));
    let previousFp = null;
    let previousCalculatedTier = null;
    const calculatedTiers = new Map();
    eligible.forEach((player, index) => {
      const tiedWithPrevious = previousFp != null && Math.abs(player.expectedWutFpPerMatch - previousFp) < 1e-9;
      const calculatedTier = tiedWithPrevious ? previousCalculatedTier : tierForRank(index, eligible.length);
      calculatedTiers.set(player.catalogKey, calculatedTier);
      if (!tierOverrides[player.catalogKey]) player.tier = calculatedTier;
      previousFp = player.expectedWutFpPerMatch;
      previousCalculatedTier = calculatedTier;
    });
    for (const player of pool.filter(item => Number(item.rarityGamesPlayed || 0) < 6)) {
      player.rarityProvisional = true;
      const tied = eligible.find(item => Math.abs(item.expectedWutFpPerMatch - player.expectedWutFpPerMatch) < 1e-9);
      const playersAhead = eligible.filter(item => item.expectedWutFpPerMatch > player.expectedWutFpPerMatch).length;
      const provisionalTier = (tied && calculatedTiers.get(tied.catalogKey)) || tierForRank(playersAhead, eligible.length);
      if (!tierOverrides[player.catalogKey]) player.tier = provisionalTier;
    }
  }
  for (const player of catalog) {
    if (player.cardType === 'mythic') player.tier = 'mythic';
    player.rarityEligible = player.cardType === 'mythic' || Number(player.rarityGamesPlayed || 0) >= 6;
    player.stars = CARD_STARS[player.tier] || 1;
  }
  return catalog.sort((a, b) =>
    normalizeSeason(a.edition).localeCompare(normalizeSeason(b.edition), undefined, { numeric: true }) ||
    a.divisionId.localeCompare(b.divisionId) ||
    a.name.localeCompare(b.name)
  );
}

async function loadManualMythicCards() {
  let raw;
  try {
    raw = await fs.readFile(MYTHIC_CARDS_PATH, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  if (!raw.trim()) return [];
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) return [];
  return Promise.all(entries.map(async (entry, index) => {
    const id = clean(entry.id || entry.mythic_id || `mythic-${index + 1}`);
    const sourceType = norm(entry.source_type || entry.sourceType || 'automatic');
    if (!['manual', 'automatic'].includes(sourceType)) {
      throw new Error(`Mythic card ${id} has an invalid source_type. Use "manual" or "automatic".`);
    }
    const sourceSeason = normalizeSeason(entry.source_season || entry.sourceSeason || entry.season || 'S3');
    const cardArt = clean(entry.card_art || entry.cardArt || 'S3').toUpperCase();
    if (!PLAYER_CARD_SEASONS.includes(cardArt)) {
      throw new Error(`Mythic card ${id} has an invalid card_art. Use "S1", "S2", or "S3".`);
    }
    const sourceStage = clean(entry.source_stage || entry.sourceStage || 'custom') || 'custom';
    const sourceDivisionId = clean(entry.source_division_id || entry.sourceDivisionId || entry.division_id || entry.divisionId || 'ALL');
    const playerKey = clean(entry.source_player_key || entry.sourcePlayerKey || entry.player_key || entry.playerKey || id);
    const teamId = clean(entry.source_team_id || entry.sourceTeamId || entry.team_id || entry.teamId || entry.TEAMID);
    const teamDisplayName = clean(entry.team_display_name || entry.teamDisplayName || entry.Team_Display_Name || entry.team_name || entry.teamName) || teamId;
    const displayName = clean(entry.display_name || entry.displayName || entry.name || `Mythic ${id}`);
    const manualLogo = path.basename(clean(entry.manual_logo || entry.manualLogo), path.extname(clean(entry.manual_logo || entry.manualLogo)));
    const manualLogoId = manualLogo || teamId;
    const manualRates = {
      goals: Math.max(0, n(entry.manual_goalrate ?? entry.manualGoalRate)),
      assists: Math.max(0, n(entry.manual_assistrate ?? entry.manualAssistRate)),
      shots: Math.max(0, n(entry.manual_shotrate ?? entry.manualShotRate)),
      hits: Math.max(0, n(entry.manual_hitrate ?? entry.manualHitRate)),
      blocks: Math.max(0, n(entry.manual_blockrate ?? entry.manualBlockRate)),
      saves: Math.max(0, n(entry.manual_saverate ?? entry.manualSaveRate)),
      shutouts: clamp(entry.manual_shutoutrate ?? entry.manualShutoutRate, 0, 1),
      savePct: clamp(entry.manual_savep ?? entry.manualSavePct, 0, 1)
    };
    const card = {
      catalogKey: cardCatalogKey({ cardType: 'mythic', mythicId: id }),
      cardIdentity: cardCatalogKey({ cardType: 'mythic', mythicId: id }),
      card_type: 'mythic',
      cardType: 'mythic',
      mythicId: id,
      edition: 'MYTHIC',
      cardArt,
      card_art: cardArt,
      sourceType,
      source_type: sourceType,
      season: sourceSeason,
      sourceSeason,
      source_season: sourceSeason,
      sourceStage,
      source_stage: sourceStage,
      sourceTeamId: teamId,
      source_team_id: teamId,
      sourcePlayerKey: playerKey,
      source_player_key: playerKey,
      sourceSteamId: clean(entry.source_steam_id || entry.sourceSteamId || entry.steam_id || entry.steamId),
      source_steam_id: clean(entry.source_steam_id || entry.sourceSteamId || entry.steam_id || entry.steamId),
      displayName,
      flavorText: clean(entry.flavor_text || entry.flavorText),
      flavor_text: clean(entry.flavor_text || entry.flavorText),
      divisionId: sourceDivisionId,
      sourceDivisionId,
      divisionName: clean(entry.division_name || entry.divisionName || sourceDivisionId),
      playerKey,
      steamId: clean(entry.source_steam_id || entry.sourceSteamId || entry.steam_id || entry.steamId),
      baseName: clean(entry.player_name || entry.playerName || displayName),
      name: displayName,
      teamId,
      teamName: teamDisplayName,
      teamDisplayName,
      position: positionGroup(entry.position) || 'F',
      positionNeedsReview: false,
      positionCountsS3: { F: 0, D: 0, G: 0 },
      positionCountsS2: { F: 0, D: 0, G: 0 },
      s2: { games: 0, fp: 0, fpPerGame: 0 },
      s3: { games: 0, fp: 0, fpPerGame: 0 },
      seasonStats: {},
      editionStats: null,
      weightedFpPerGame: Number(entry.rating_fp_per_game || entry.ratingFpPerGame || 0),
      tier: 'mythic',
      stars: CARD_STARS.mythic,
      teamLogo: clean(entry.team_logo || entry.teamLogo) ||
        (sourceType === 'manual' && manualLogoId
          ? `/images/casino/WUT/Logos/${encodeURIComponent(manualLogoId)}.png`
          : `/images/casino/${sourceSeason}/${teamId}.png`),
      unavailableStats: Array.isArray(entry.unavailable_stats || entry.unavailableStats)
        ? (entry.unavailable_stats || entry.unavailableStats).map(item => clean(item).toLowerCase())
        : [],
      manualRates,
      scoringPool: entry.scoring_pool || entry.scoringPool || {
        season: sourceSeason,
        stage: sourceStage,
        sampleSize: HISTORICAL_SAMPLE_SIZE
      }
    };
    return card;
  }));
}

function rollWeighted(odds, allowed = CARD_TIERS) {
  const entries = allowed.map(key => [key, Math.max(0, n(odds[key]))]);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return allowed[0];
  let roll = Math.random() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return entries.at(-1)[0];
}

function rarityRollsForPack(packType, oddsByPack) {
  const odds = oddsByPack?.[packType] || oddsByPack?.standard || {};
  return [rollWeighted(odds), rollWeighted(odds), rollWeighted(odds)];
}

export function isPlayerPackEligible(player) {
  if (!player?.position) return false;
  if (
    PACK_EXCLUDED_PLAYER_NAMES.has(norm(player.baseName)) ||
    PACK_EXCLUDED_STEAM_IDS.has(clean(player.sourceSteamId || player.steamId))
  ) return false;
  if (player.cardType === 'mythic' || player.card_type === 'mythic' || player.edition === 'MYTHIC' || player.tier === 'mythic') {
    return true;
  }
  if (normalizeSeason(player.edition || player.season) !== 'S3') return true;
  const gamesPlayed = Number(
    player.editionStats?.games ??
    player.seasonStats?.S3?.games ??
    player.s3?.games ??
    0
  );
  return Number.isFinite(gamesPlayed) && gamesPlayed >= 6;
}

function pickUniquePlayer(catalog, tier, usedKeys) {
  const exact = catalog.filter(player => player.tier === tier && player.position && !usedKeys.has(player.catalogKey));
  const fallback = catalog.filter(player => player.position && !usedKeys.has(player.catalogKey));
  const pool = exact.length ? exact : fallback;
  if (!pool.length) throw new Error('Not enough unique eligible players to generate this pack.');
  return pool[Math.floor(Math.random() * pool.length)];
}

function playerPackItem(player) {
  return {
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
    position: player.position,
    rolledTier: player.tier
  };
}

export function generatePlayerPack({ packType, catalog, config }) {
  const eligibleCatalog = catalog.filter(isPlayerPackEligible);
  const used = new Set();
  const tiers = rarityRollsForPack(packType, config.playerTierOdds);
  const players = tiers.map(tier => {
    const player = pickUniquePlayer(eligibleCatalog, tier, used);
    used.add(player.catalogKey);
    return playerPackItem(player);
  });
  if (['premium', 'prestige'].includes(packType) && !players.some(player => CARD_STARS[player.rolledTier] >= CARD_STARS.rare)) {
    used.delete(players.at(-1).catalogKey);
    const rarePlusPool = eligibleCatalog.filter(player =>
      CARD_STARS[player.tier] >= CARD_STARS.rare && !used.has(player.catalogKey)
    );
    const availableRarePlusTiers = CARD_TIERS.filter(tier => rarePlusPool.some(player => player.tier === tier));
    if (!availableRarePlusTiers.length) throw new Error(`No Rare-or-better players are eligible for a ${packType} pack.`);
    const guaranteedTier = rollWeighted(config.playerTierOdds?.[packType] || {}, availableRarePlusTiers);
    players[players.length - 1] = playerPackItem(pickUniquePlayer(rarePlusPool, guaranteedTier, used));
  }
  return players;
}

// Every WUT 2.0 player pack is a single five-item product: three players and
// two boosts. Keeping generation here makes the economy route impossible to
// accidentally split back into Mushybux-powered boost packs.
export function generateWutPlayerPack({ packType, catalog, config }) {
  const players = generatePlayerPack({ packType, catalog, config });
  const boosts = generateBoostPack({ packType, config }).slice(0, 2);
  return [...players, ...boosts];
}

export function availableWutMatchCards(cards, placements, userId) {
  const committedIds = new Set((placements || [])
    .filter(row => Number(row.user_id) === Number(userId))
    .map(row => Number(row.card_id)));
  return (cards || []).filter(card => !committedIds.has(Number(card.id)));
}

export function generateWutStarterPack(catalog) {
  const used = new Set();
  return ['F', 'F', 'D', 'D', 'G'].map(position => {
    const pool = catalog.filter(player =>
      isPlayerPackEligible(player) &&
      player.tier === 'common' &&
      player.position === position &&
      !used.has(player.catalogKey)
    );
    if (!pool.length) throw new Error(`Not enough unique common ${position} cards to open a WUT starter pack.`);
    const player = pool[Math.floor(Math.random() * pool.length)];
    used.add(player.catalogKey);
    return playerPackItem(player);
  });
}

export function generateBoostPack({ packType, config }) {
  const rarities = rarityRollsForPack(packType, config.boostRarityOdds).map(rarity => rarity === 'mythic' ? 'legendary' : rarity);
  return rarities.map(rarity => {
    const boostType = BOOST_TYPES[Math.floor(Math.random() * BOOST_TYPES.length)];
    return {
      itemType: 'boost',
      boostType,
      rarity,
      effect: config.boostEffects?.[boostType]?.[rarity] || DEFAULT_BOOST_EFFECTS[boostType]?.[rarity]
    };
  });
}

export async function getCardSeriesOptions({ seasonId = 'S3', week, divisionId, teamId }) {
  const series = await getUpcomingSeries(week, seasonId);
  return series.filter(item =>
    item.division_id === divisionId &&
    [item.home_team_id, item.away_team_id].includes(teamId)
  ).map(item => ({
    seriesKey: item.series_key,
    opponentTeamId: item.home_team_id === teamId ? item.away_team_id : item.home_team_id,
    opponentTeamName: item.home_team_id === teamId ? item.away_team_name : item.home_team_name,
    voided: item.games.some(game =>
      ['postponed', 'void', 'voided', 'cancelled', 'canceled'].includes(norm(game.status))
    )
  }));
}

export async function scoreCardSeries({
  seasonId = 'S3',
  divisionId,
  player,
  position,
  seriesKey,
  boost = null,
  scoringConfig = {}
}) {
  const boxscores = await getBoxscores(divisionId, seasonId);
  const seriesId = clean(seriesKey).replace(`${divisionId}-`, '');
  const steam = norm(player.steamId);
  const name = norm(player.baseName || player.name);
  const rows = boxscores.filter(row =>
    clean(row.match_id).replace(/-G\d+$/, '') === seriesId &&
    ((steam && norm(row.steam_id) === steam) || (!steam && norm(row.player_name) === name)) &&
    positionGroup(row.position) === position
  );
  const base = fantasyPointsForRows(rows, position, scoringConfig);
  const unavailableStats = player.unavailableStats || [];
  const exact = applyBoostToFantasy(base, boost, { unavailableStats });
  return {
    gamesPlayed: rows.length,
    fp: Math.round(exact),
    exactFp: exact,
    stats: base.stats,
    breakdown: buildFantasyBreakdown(base.stats, position, boost, { unavailableStats, scoringConfig })
  };
}

async function stageMatchIdsFor(divisionId, seasonId, stage) {
  const cleanStage = norm(stage);
  if (!cleanStage || cleanStage === 'custom' || cleanStage === 'reg') return null;

  const schedule = await getSchedule(divisionId, seasonId);
  const ids = new Set();
  for (const row of schedule || []) {
    const rowStage = norm(row.stage || 'reg');
    const isStageMatch = cleanStage === 'playoffs'
      ? rowStage && rowStage !== 'reg'
      : rowStage === cleanStage;
    if (isStageMatch && clean(row.match_id)) ids.add(clean(row.match_id));
  }
  return ids.size ? ids : null;
}

function playerRowsFromBoxscores(boxscores, player, position, stage = '', allowedMatchIds = null) {
  const steam = norm(player.sourceSteamId || player.steamId);
  const name = norm(player.baseName || player.name);
  const cleanStage = norm(stage);
  return (boxscores || []).filter(row => {
    const rowStage = norm(row.stage || 'reg');
    const stageMatches =
      !cleanStage ||
      cleanStage === 'custom' ||
      rowStage === cleanStage ||
      (cleanStage === 'playoffs' && rowStage !== 'reg') ||
      (allowedMatchIds && allowedMatchIds.has(clean(row.match_id)));
    return stageMatches &&
      ((steam && norm(row.steam_id) === steam) || (!steam && norm(row.player_name) === name)) &&
      positionGroup(row.position) === position;
  });
}

function chooseSampleMatchIds(rows, existingIds = [], sampleSize = HISTORICAL_SAMPLE_SIZE, excludedIds = []) {
  const excluded = new Set((excludedIds || []).map(clean).filter(Boolean));
  const available = [...new Set(rows.map(row => clean(row.match_id)).filter(id => id && !excluded.has(id)))];
  const existing = (existingIds || []).map(clean).filter(id => available.includes(id));
  if (existing.length) return existing;
  const pool = [...available];
  const picked = [];
  while (pool.length && picked.length < sampleSize) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

function generateS1SyntheticGames(player, position, sampleSize = HISTORICAL_SAMPLE_SIZE) {
  const stats = player.editionStats || player.seasonStats?.S1 || {};
  const games = Math.max(1, n(stats.games));
  if (position === 'G') {
    const historicalSavePct = n(stats.savePct) || (n(stats.shotsAgainst) > 0
      ? Math.max(0, n(stats.shotsAgainst) - n(stats.goalsAgainst)) / n(stats.shotsAgainst)
      : 0);
    const shotsMean = n(stats.shotsAgainst) / games;
    const minimumShots = Math.max(0, Math.floor(shotsMean * S1_GOALIE_SHOTS_MIN_FACTOR));
    const maximumShots = Math.max(minimumShots, Math.ceil(shotsMean * S1_GOALIE_SHOTS_MAX_FACTOR));
    const shutoutRate = clamp(n(stats.shutouts) / games, 0, 1);
    const rows = Array.from({ length: sampleSize }, (_, index) => {
      const shotsAgainst = Math.min(maximumShots, Math.max(minimumShots, randomPoisson(shotsMean)));
      const targetSavePct = clamp(
        historicalSavePct + randomCenteredDeviation(S1_GOALIE_SAVE_PCT_MAX_DEVIATION),
        Math.max(0, historicalSavePct - S1_GOALIE_SAVE_PCT_MAX_DEVIATION),
        Math.min(1, historicalSavePct + S1_GOALIE_SAVE_PCT_MAX_DEVIATION)
      );
      const isShutout = shotsAgainst > 0 && Math.random() < shutoutRate;
      const goalsAgainst = isShutout
        ? 0
        : Math.min(shotsAgainst, Math.max(shotsAgainst > 0 ? 1 : 0, Math.round(shotsAgainst * (1 - targetSavePct))));
      return {
        synthetic: true,
        match_id: `S1-SYN-${index + 1}`,
        player_name: player.baseName || player.name,
        steam_id: player.sourceSteamId || player.steamId || '',
        position: 'G',
        sa: shotsAgainst,
        ga: goalsAgainst,
        so: shotsAgainst > 0 && goalsAgainst === 0 ? 1 : 0
      };
    });
    return capSyntheticGoalieSavePct(rows, historicalSavePct);
  }
  return Array.from({ length: sampleSize }, (_, index) => {
    const matchId = `S1-SYN-${index + 1}`;
    const goals = randomPoisson(n(stats.goals) / games);
    const assists = randomPoisson(n(stats.assists) / games);
    const shots = Math.max(goals, randomPoisson(n(stats.shots) / games));
    const rates = player.s1SyntheticRates || {
      hitsPerGame: n(stats.hits) / games,
      blocksPerGame: n(stats.blocks) / games
    };
    return {
      synthetic: true,
      match_id: matchId,
      player_name: player.baseName || player.name,
      steam_id: player.sourceSteamId || player.steamId || '',
      position,
      g: goals,
      a: assists,
      shots,
      hits: randomPoisson(n(rates.hitsPerGame)),
      blocks: randomPoisson(n(rates.blocksPerGame))
    };
  });
}

const S1_WUT_GAMES_PATH = path.resolve('./data/S1/s1_wut_synthetic_games.csv');
let s1WutGamesPromise = null;

async function permanentS1Games(player, position) {
  s1WutGamesPromise ||= readCsvFile(S1_WUT_GAMES_PATH).catch(() => {
    // Do not permanently cache a missing generated file. This lets a running
    // development server recover as soon as `npm run wut:s1-games` creates it.
    s1WutGamesPromise = null;
    return [];
  });
  const rows = await s1WutGamesPromise;
  const steam = norm(player.sourceSteamId || player.steamId);
  const name = norm(player.baseName || player.name);
  return rows.filter(row => ((steam && norm(row.steam_id) === steam) || (!steam && norm(row.player_name) === name)) && positionGroup(row.position) === position);
}

function generateManualMythicGames(player, position, sampleSize = HISTORICAL_SAMPLE_SIZE, startIndex = 0) {
  const rates = player.manualRates || {};
  return Array.from({ length: sampleSize }, (_, index) => {
    const matchId = `MYTHIC-MANUAL-${startIndex + index + 1}`;
    if (position === 'G') {
      const saves = randomPoisson(rates.saves);
      const isShutout = Math.random() < clamp(rates.shutouts, 0, 1);
      const savePct = clamp(rates.savePct, 0, 1);
      const expectedGoalsAgainst = savePct > 0
        ? saves * (1 - savePct) / savePct
        : saves > 0 ? saves : 0;
      const goalsAgainst = isShutout ? 0 : Math.max(saves > 0 ? 1 : 0, randomPoisson(expectedGoalsAgainst));
      return {
        synthetic: true,
        match_id: matchId,
        player_name: player.baseName || player.name,
        steam_id: player.sourceSteamId || player.steamId || '',
        position: 'G',
        sa: saves + goalsAgainst,
        ga: goalsAgainst,
        so: isShutout ? 1 : 0
      };
    }
    const goals = randomPoisson(rates.goals);
    return {
      synthetic: true,
      match_id: matchId,
      player_name: player.baseName || player.name,
      steam_id: player.sourceSteamId || player.steamId || '',
      position,
      g: goals,
      a: randomPoisson(rates.assists),
      shots: Math.max(goals, randomPoisson(rates.shots)),
      hits: randomPoisson(rates.hits),
      blocks: randomPoisson(rates.blocks)
    };
  });
}

export async function scoreHistoricalCardSample({
  player,
  position,
  boost = null,
  sampleMatchIds = [],
  syntheticGames = [],
  excludeMatchIds = [],
  scoringConfig = {}
}) {
  const sourceSeason = normalizeSeason(player.sourceSeason || player.edition || player.season);
  const sourceType = norm(player.sourceType || player.source_type) === 'manual' ? 'manual' : 'automatic';
  if (sourceType === 'manual' || sourceSeason === 'S1') {
    const permanentRows = sourceSeason === 'S1' ? await permanentS1Games(player, position) : [];
    if (sourceSeason === 'S1' && !permanentRows.length && !(Array.isArray(syntheticGames) && syntheticGames.length)) {
      throw new Error(`Permanent S1 WUT games are missing for ${player.baseName || player.name}. Expected ${S1_WUT_GAMES_PATH}.`);
    }
    const permanentSampleIds = sourceSeason === 'S1'
      ? chooseSampleMatchIds(permanentRows, sampleMatchIds, Number(player.scoringPool?.sampleSize || HISTORICAL_SAMPLE_SIZE), excludeMatchIds)
      : [];
    const selected = Array.isArray(syntheticGames) && syntheticGames.length
      ? syntheticGames
      : sourceType === 'manual'
        ? generateManualMythicGames(player, position, Number(player.scoringPool?.sampleSize || HISTORICAL_SAMPLE_SIZE), (excludeMatchIds || []).length)
        : permanentRows.filter(row => permanentSampleIds.includes(clean(row.match_id)));
    const unavailableStats = player.unavailableStats || [];
    const base = fantasyPointsForRows(selected, position, scoringConfig);
    const boostedExact = applyBoostToFantasy(base, boost, { unavailableStats });
    const exact = boostedExact;
    const breakdown = buildFantasyBreakdown(base.stats, position, boost, { unavailableStats, scoringConfig });
    return {
      gamesPlayed: selected.length,
      fp: Math.round(exact),
      exactFp: exact,
      stats: base.stats,
      sampleMatchIds: selected.map(row => clean(row.match_id)).filter(Boolean),
      syntheticGames: selected,
      rolledGames: selected,
      breakdown,
      gameFps: selected.map(row => fantasyPointsForRows([row], position, scoringConfig).exact)
    };
  }

  const sourceDivisionId = clean(player.sourceDivisionId || player.divisionId);
  const sourceStage = clean(player.sourceStage || 'reg') || 'reg';
  const boxscores = await getBoxscores(sourceDivisionId, sourceSeason);
  const allowedMatchIds = await stageMatchIdsFor(sourceDivisionId, sourceSeason, sourceStage);
  const rows = playerRowsFromBoxscores(boxscores, player, position, sourceStage, allowedMatchIds);
  const selectedMatchIds = chooseSampleMatchIds(rows, sampleMatchIds, Number(player.scoringPool?.sampleSize || HISTORICAL_SAMPLE_SIZE), excludeMatchIds);
  const selected = rows.filter(row => selectedMatchIds.includes(clean(row.match_id)));
  if (selected.length === 0) {
    return {
      gamesPlayed: 0,
      fp: 0,
      exactFp: 0,
      stats: {},
      sampleMatchIds: selectedMatchIds,
      breakdown: [],
      rolledGames: [],
      warning: 'Historical sample could not be resolved. Card and boost preserved.'
    };
  }

  const unavailableStats = player.unavailableStats || [];
  const base = fantasyPointsForRows(selected, position, scoringConfig);
  const boostedExact = applyBoostToFantasy(base, boost, { unavailableStats });
  const exact = boostedExact;
  const breakdown = buildFantasyBreakdown(base.stats, position, boost, { unavailableStats, scoringConfig });
  return {
    gamesPlayed: selected.length,
    fp: Math.round(exact),
    exactFp: exact,
    stats: base.stats,
    sampleMatchIds: selectedMatchIds,
    syntheticGames: [],
    rolledGames: selected,
    breakdown,
    gameFps: selected.map(row => fantasyPointsForRows([row], position, scoringConfig).exact)
  };
}
