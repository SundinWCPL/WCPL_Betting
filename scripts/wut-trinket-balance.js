import fs from 'fs/promises';
import path from 'path';
import {
  applyWutPositiveScoring,
  boostFantasyBonus,
  buildCardPlayerCatalog,
  buildFantasyBreakdown,
  captainPatchChemistry,
  chemistryMultiplierForCount,
  fantasyPointsForRows,
  isPlayerPackEligible,
  resolveWutMatchingTrinkets
} from '../services/cards.js';
import {
  WUT_LAUNCH_TRINKET_EFFECTS,
  WUT_LINEUP_SLOTS,
  WUT_RARITIES,
  adjacentWutSlots,
  chooseJourneymanIdentity,
  resolveJourneymanIdentity,
  resolveZebraStripes,
  trinketFitsWutPosition
} from '../services/wutBalanceRules.js';

const ROOT = path.resolve('.');
const TRIALS = Math.max(250, Number(process.argv.find(arg => arg.startsWith('--trials='))?.split('=')[1] || 5000));
const SEED = Number(process.argv.find(arg => arg.startsWith('--seed='))?.split('=')[1] || 20260702);
const OUTPUT = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.split('=')[1] || 'data/wut-trinket-balance.json');
const FAMILY_FILTER = String(process.argv.find(arg => arg.startsWith('--families='))?.split('=')[1] || '').split(',').map(value => value.trim()).filter(Boolean);
const SCORING = {
  statPoints: { goal: 10, assist: 7, shot: 1, hit: 3, block: 4, save: 2, shutout: 10 },
  savePctBonuses: [
    { threshold: 0, multiplier: .85 }, { threshold: .85, multiplier: 1 },
    { threshold: .9, multiplier: 1.1 }, { threshold: .925, multiplier: 1.2 },
    { threshold: .95, multiplier: 1.35 }, { threshold: .975, multiplier: 1.5 }
  ],
  chemistryBonuses: { 2: 10, 3: 15, 4: 20, 5: 25 }
};
const BOOST_EFFECTS = {
  goal: { common: [1, 2], uncommon: [1, 3], rare: [1, 5], epic: [1, 7], legendary: [1, 10] },
  assist: { common: [1, 1], uncommon: [1, 2], rare: [1, 3], epic: [1, 5], legendary: [1, 7] },
  shot: { common: [4, 1], uncommon: [3, 1], rare: [2, 1], epic: [1, 1], legendary: [1, 2] },
  grit: { common: [1, 1], uncommon: [1, 2], rare: [1, 3], epic: [1, 5], legendary: [1, 7] },
  save: { common: [8, 1], uncommon: [5, 1], rare: [3, 1], epic: [2, 1], legendary: [1, 1] },
  shutout: { common: [1, 5], uncommon: [1, 10], rare: [1, 15], epic: [1, 25], legendary: [1, 40] }
};

function csvRows(text) {
  const lines = text.trim().split(/\r?\n/);
  const parse = line => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { values.push(value); value = ''; }
      else value += char;
    }
    values.push(value);
    return values;
  };
  const headers = parse(lines.shift());
  return lines.filter(Boolean).map(line => Object.fromEntries(headers.map((key, index) => [key, parse(line)[index] || ''])));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const pick = (items, random) => items[Math.floor(random() * items.length)];
function shuffled(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)))];
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }

function effect(family, rarity) {
  return structuredClone(WUT_LAUNCH_TRINKET_EFFECTS[family][rarity]);
}

function trinket(family, rarity) { return { family, rarity, effect: effect(family, rarity) }; }

function randomBoost(position, maxLoad, random) {
  if (maxLoad < 1) return null;
  const load = 1 + Math.floor(random() * Math.min(5, maxLoad));
  const rarity = WUT_RARITIES[load - 1];
  const types = position === 'G' ? ['save', 'shutout'] : ['goal', 'assist', 'shot', 'grit'];
  const type = pick(types, random);
  const [per, bonus] = BOOST_EFFECTS[type][rarity];
  return { boost_type: type, rarity, load, effect: { per, bonus } };
}

function bestBoostOptions(entry) {
  const types = entry.player.position === 'G' ? ['save', 'shutout'] : ['goal', 'assist', 'shot', 'grit'];
  const options = [{ boost: null, load: 0, gain: 0 }];
  for (let load = 1; load <= 5; load += 1) {
    const rarity = WUT_RARITIES[load - 1];
    const candidates = types.map(type => {
      const [per, bonus] = BOOST_EFFECTS[type][rarity];
      const boost = { boost_type: type, rarity, load, effect: { per, bonus } };
      return { boost, load, gain: boostFantasyBonus(entry.stats, boost) };
    });
    options.push(candidates.sort((a, b) => b.gain - a.gain)[0]);
  }
  return options;
}

function optimizeConnectedBoosts(entries, focal, cap, cableEffect = null) {
  const connected = [focal, ...entries.filter(entry =>
    entry.userId === focal.userId && adjacentWutSlots(focal.slot).includes(entry.slot)
  )];
  const optionSets = connected.map(bestBoostOptions);
  let best = { score: -Infinity, load: Infinity, plan: {} };
  const visit = (index, chosen, load) => {
    if (load > cap) return;
    if (index < connected.length) {
      for (const option of optionSets[index]) visit(index + 1, [...chosen, option], load + option.load);
      return;
    }
    const gains = chosen.map(option => option.gain);
    let score = gains.reduce((sum, gain) => sum + gain, 0);
    if (cableEffect) {
      score += gains[0] * Number(cableEffect.own || 0);
      const adjacent = gains.slice(1);
      const echoed = cableEffect.adjacentMode === 'strongest' ? Math.max(0, ...adjacent) : adjacent.reduce((sum, gain) => sum + gain, 0);
      score += echoed * Number(cableEffect.adjacent || 0);
    }
    if (score > best.score || (score === best.score && load < best.load)) {
      best = {
        score,
        load,
        plan: Object.fromEntries(connected.map((entry, slotIndex) => [entry.slot, chosen[slotIndex].boost]))
      };
    }
  };
  visit(0, [], 0);
  return best.plan;
}

async function loadPool() {
  const [s1GamesText, catalog, s2BoxesText, s2ScheduleText, s3D1BoxesText, s3D1ScheduleText, s3D2BoxesText, s3D2ScheduleText] = await Promise.all([
    fs.readFile(path.join(ROOT, 'data/S1/s1_wut_synthetic_games.csv'), 'utf8'),
    buildCardPlayerCatalog({ seasonId: 'S3', scoringConfig: SCORING }),
    fs.readFile(path.join(ROOT, 'data/S2/boxscores.csv'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/S2/schedule.csv'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/S3/D1/boxscores.csv'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/S3/D1/schedule.csv'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/S3/D2/boxscores.csv'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/S3/D2/schedule.csv'), 'utf8')
  ]);
  const sourceRows = {
    S1: csvRows(s1GamesText),
    'S2|ALL': csvRows(s2BoxesText),
    'S3|D1': csvRows(s3D1BoxesText),
    'S3|D2': csvRows(s3D2BoxesText)
  };
  const schedules = {
    'S2|ALL': csvRows(s2ScheduleText),
    'S3|D1': csvRows(s3D1ScheduleText),
    'S3|D2': csvRows(s3D2ScheduleText)
  };
  const groupPosition = value => {
    const clean = String(value || '').toUpperCase();
    return clean === 'G' ? 'G' : clean.includes('D') ? 'D' : clean ? 'F' : '';
  };
  const mythicRandom = mulberry32(SEED ^ 0x51f15e);
  const poisson = lambda => {
    if (lambda <= 0) return 0;
    const limit = Math.exp(-lambda);
    let product = 1;
    let count = 0;
    do { count += 1; product *= mythicRandom(); } while (product > limit);
    return count - 1;
  };
  const manualGames = card => Array.from({ length: 60 }, (_, index) => {
    const rates = card.manualRates || {};
    if (card.position === 'G') {
      const saves = poisson(Number(rates.saves || 0));
      const shutout = mythicRandom() < Number(rates.shutouts || 0);
      const savePct = Number(rates.savePct || 0);
      const expectedGa = savePct > 0 ? saves * (1 - savePct) / savePct : 0;
      const ga = shutout ? 0 : Math.max(saves ? 1 : 0, poisson(expectedGa));
      return { match_id: `SIM-MYTHIC-${index}`, position: 'G', sa: saves + ga, ga, so: shutout ? 1 : 0 };
    }
    const goals = poisson(Number(rates.goals || 0));
    return { match_id: `SIM-MYTHIC-${index}`, position: card.position, g: goals, a: poisson(Number(rates.assists || 0)), shots: Math.max(goals, poisson(Number(rates.shots || 0))), hits: poisson(Number(rates.hits || 0)), blocks: poisson(Number(rates.blocks || 0)) };
  });
  const players = [];
  const obtainableCatalog = catalog.filter(isPlayerPackEligible);
  for (const card of obtainableCatalog) {
    const season = String(card.sourceSeason || card.edition || 'S3').toUpperCase();
    const division = String(card.sourceDivisionId || card.divisionId || 'ALL').toUpperCase();
    let games = [];
    if (season === 'S1') {
      games = sourceRows.S1.filter(row => String(row.player_name).toLowerCase() === String(card.baseName || card.name).toLowerCase() && groupPosition(row.position) === card.position);
    } else if (String(card.sourceType || '').toLowerCase() === 'manual') {
      games = manualGames(card);
    } else {
      const sourceKey = `${season}|${division}`;
      const rows = sourceRows[sourceKey] || [];
      const steam = String(card.sourceSteamId || card.steamId || '').trim();
      const sourceName = String(card.sourcePlayerKey || '').replace(/^name:/i, '') || card.baseName || card.name;
      const stage = String(card.sourceStage || 'reg').toLowerCase();
      const stageIds = new Set((schedules[sourceKey] || []).filter(row => {
        const rowStage = String(row.stage || 'reg').toLowerCase();
        return rowStage === stage || (stage === 'playoffs' && rowStage !== 'reg');
      }).map(row => String(row.match_id)));
      games = rows.filter(row =>
        groupPosition(row.position) === card.position &&
        (!stageIds.size || stageIds.has(String(row.match_id))) &&
        (steam ? String(row.steam_id).trim() === steam : String(row.player_name).toLowerCase() === String(sourceName).toLowerCase())
      );
    }
    if (!games.length) continue;
    const chemistrySeason = card.cardType === 'mythic' ? season : String(card.edition || season).toUpperCase();
    players.push({
      key: card.cardIdentity,
      name: card.name,
      position: card.position,
      team: card.teamId || card.sourceTeamId || 'UNKNOWN',
      season: chemistrySeason,
      edition: card.edition,
      rarity: card.tier,
      cardPower: Number(card.stars || (WUT_RARITIES.indexOf(card.tier) + 1) || 1),
      games
    });
  }
  const volatility = players.map(player => {
    const values = player.games.map(row => fantasyPointsForRows([row], player.position, SCORING).exact);
    const average = mean(values);
    const deviation = Math.sqrt(mean(values.map(value => (value - average) ** 2)));
    return { player, cv: average > 0 ? deviation / average : 0 };
  }).sort((a, b) => a.cv - b.cv);
  volatility.forEach((row, index) => {
    const percentile = index / Math.max(1, volatility.length);
    row.player.volatilityBand = percentile < .25 ? 'low' : percentile < .5 ? 'mid_low' : percentile < .75 ? 'mid_high' : 'high';
    row.player.volatilityCv = row.cv;
  });
  players.meta = {
    catalogCards: catalog.length,
    obtainableCards: obtainableCatalog.length,
    positionedCards: catalog.filter(card => card.position).length,
    unpositionedCards: catalog.filter(card => !card.position).map(card => card.name),
    provisionalS3Cards: catalog.filter(card => card.edition === 'S3' && !isPlayerPackEligible(card)).map(card => card.name),
    obtainableWithoutGames: obtainableCatalog.filter(card => !players.some(player => player.key === card.cardIdentity)).map(card => card.name)
  };
  return players;
}

function samplePlayer(players, position, used, random, chemistryKey = '') {
  const eligible = players.filter(player => player.position === position && !used.has(player.key) && (!chemistryKey || `${player.season}|${player.team}` === chemistryKey));
  const player = pick(eligible, random) || pick(players.filter(item => item.position === position && !used.has(item.key)), random);
  used.add(player.key);
  return player;
}

function rawEntry(player, side, slot, random) {
  const rows = shuffled(player.games, random);
  const rolledGames = rows.slice(0, 3);
  const bonusGames = rows.slice(3, 6);
  const base = fantasyPointsForRows(rolledGames, player.position, SCORING);
  const powerRoll = random();
  const backgroundTrinketPower = powerRoll < .1 ? 0
    : powerRoll < .4 ? 1
      : powerRoll < .625 ? 2
        : powerRoll < .7 ? 3
          : powerRoll < .955 ? 4 : 5;
  return {
    userId: side,
    slot,
    player,
    printedChemistryKey: `${player.season}|${player.team}`,
    chemistryKey: `${player.season}|${player.team}`,
    power: player.cardPower + backgroundTrinketPower,
    rolledGames,
    bonusGames,
    gameFps: rolledGames.map(row => fantasyPointsForRows([row], player.position, SCORING).exact),
    bonusGameFps: bonusGames.map(row => fantasyPointsForRows([row], player.position, SCORING).exact),
    baseExactFp: base.exact,
    stats: base.stats,
    breakdown: buildFantasyBreakdown(base.stats, player.position, null, { scoringConfig: SCORING }),
    boost: null,
    trinket: null,
    committedAt: random(),
    journeymanRoll: random()
  };
}

function buildMatch(players, random) {
  const entries = [];
  for (const side of [1, 2]) {
    const used = new Set();
    for (const slot of WUT_LINEUP_SLOTS) entries.push(rawEntry(samplePlayer(players, slot[0], used, random), side, slot, random));
  }
  for (const side of [1, 2]) {
    let budget = 5;
    for (const entry of shuffled(entries.filter(row => row.userId === side), random)) {
      if (budget && random() < .55) {
        entry.boost = randomBoost(entry.player.position, budget, random);
        budget -= entry.boost?.load || 0;
      }
    }
  }
  return entries;
}

function replaceEntry(entries, target, players, used, random, chemistryKey) {
  const player = samplePlayer(players, target.slot[0], used, random, chemistryKey);
  const replacement = rawEntry(player, target.userId, target.slot, random);
  replacement.trinket = target.trinket;
  replacement.boost = target.boost;
  replacement.power = player.cardPower + (target.trinket ? WUT_RARITIES.indexOf(target.trinket.rarity) + 1 : 0);
  Object.assign(target, replacement);
}

function forceChemistryStack(entries, players, side, focal, count, random, requestedKey = '', excluded = []) {
  const used = new Set(entries.filter(entry => entry.userId === side).map(entry => entry.player.key));
  const targets = [focal, ...shuffled(entries.filter(entry => entry.userId === side && entry !== focal && !excluded.includes(entry)), random)].slice(0, count);
  const required = Object.fromEntries(['F', 'D', 'G'].map(position => [position, targets.filter(target => target.slot[0] === position).length]));
  const candidateKeys = [...new Set(players.map(player => `${player.season}|${player.team}`))].filter(chemistryKey => {
    return ['F', 'D', 'G'].every(position => players.filter(player => `${player.season}|${player.team}` === chemistryKey && player.position === position).length >= required[position]);
  });
  const focalKey = `${focal.player.season}|${focal.player.team}`;
  const chemistryKey = candidateKeys.includes(requestedKey)
    ? requestedKey
    : candidateKeys.includes(focalKey) ? focalKey : pick(candidateKeys, random);
  for (const target of targets) {
    if (`${target.player.season}|${target.player.team}` === chemistryKey) continue;
    used.delete(target.player.key);
    replaceEntry(entries, target, players, used, random, chemistryKey);
  }
  return chemistryKey;
}

function effectiveChemistry(entries, random) {
  for (const entry of entries) entry.chemistryKey = entry.printedChemistryKey;
  for (const entry of entries.filter(row => row.trinket?.family === 'journeyman')) {
    entry.chemistryKey = resolveJourneymanIdentity(entry, entries, entry.journeymanKey, () => entry.journeymanRoll);
  }
  return entries;
}

function scoreMatch(sourceEntries, random) {
  const committed = structuredClone(sourceEntries);
  for (const entry of committed.filter(row => row.trinket?.family === 'journeyman')) {
    entry.journeymanKey = chooseJourneymanIdentity(entry, committed, () => entry.journeymanRoll);
  }
  const entries = effectiveChemistry(resolveZebraStripes(committed), random);
  const baseBoosts = new Map(entries.map(entry => [entry, boostFantasyBonus(entry.stats, entry.boost)]));
  const positives = [];
  for (const entry of entries) {
    const ownSide = entries.filter(other => other.userId === entry.userId);
    const crossSideJourneyman = entry.trinket?.family === 'journeyman' && entry.trinket.effect?.crossSide;
    const teamCount = entries.filter(other =>
      other.chemistryKey === entry.chemistryKey && (crossSideJourneyman || other.userId === entry.userId)
    ).length;
    const baseChemistry = chemistryMultiplierForCount(teamCount, SCORING);
    const captain = ownSide.filter(other => other.chemistryKey === entry.chemistryKey && other.trinket?.family === 'team_crest')
      .sort((a, b) => Number(b.trinket.effect || 0) - Number(a.trinket.effect || 0))[0];
    const chemistry = captainPatchChemistry(baseChemistry, captain ? [captain.trinket.effect] : []);
    const opponent = entries.find(other => other.userId !== entry.userId && other.slot === entry.slot);
    const adjacentBoostGains = ownSide.filter(other => adjacentWutSlots(entry.slot).includes(other.slot)).map(other => baseBoosts.get(other));
    const layers = applyWutPositiveScoring({
      baseExactFp: entry.baseExactFp,
      trinket: entry.trinket,
      gameFps: entry.gameFps,
      bonusGameFps: entry.bonusGameFps,
      breakdown: entry.breakdown,
      stats: entry.stats,
      isFirst: entry.committedAt < opponent.committedAt,
      hasOpponent: true,
      teamCount,
      // Underdog compares the underlying cards. Including its own trinket
      // rarity makes higher-rarity Underdog Patches activate less often.
      power: entry.player.cardPower,
      opponentPower: opponent.player.cardPower,
      boost: entry.boost,
      boostLoad: entry.boost?.load || 0,
      adjacentBoostGains,
      chemistryMultiplier: chemistry.multiplier
    });
    positives.push({
      ...entry,
      placement: { user_id: entry.userId, slot: entry.slot },
      wouldBeFp: layers.wouldBeFp,
      finalFp: layers.wouldBeFp,
      layers,
      logs: [],
      scoringEffects: []
    });
  }
  return resolveWutMatchingTrinkets(positives);
}

function totals(scored) {
  const one = scored.filter(entry => entry.userId === 1).reduce((sum, entry) => sum + Math.max(0, entry.finalFp), 0);
  const two = scored.filter(entry => entry.userId === 2).reduce((sum, entry) => sum + Math.max(0, entry.finalFp), 0);
  return { one, two, margin: one - two };
}

const SELF_TARGETS = ['lucky_charm', 'safety_net', 'glass_skates', 'specialist_tape', 'first_strike_tape', 'counterpunch_gloves', 'underdog_patch', 'team_crest', 'siphon_stone', 'journeyman', 'booster_cable', 'generalist'];

function prepareScenario(entries, players, family, rarity, random) {
  let candidates = entries.filter(entry => entry.userId === 1);
  candidates = candidates.filter(entry => trinketFitsWutPosition(family, entry.player.position));
  let focal = pick(candidates, random);
  focal.trinket = trinket(family, rarity);
  focal.power = focal.player.cardPower + WUT_RARITIES.indexOf(rarity) + 1;
  const opposite = entries.find(entry => entry.userId === 2 && entry.slot === focal.slot);

  if (family === 'first_strike_tape') focal.committedAt = Math.min(focal.committedAt, opposite.committedAt - 1);
  if (family === 'counterpunch_gloves') focal.committedAt = Math.max(focal.committedAt, opposite.committedAt + 1);
  if (family === 'team_crest') forceChemistryStack(entries, players, 1, focal, 2 + Math.floor(random() * 4), random);
  if (family === 'booster_cable') {
    for (const entry of entries.filter(entry => entry.userId === focal.userId)) entry.boost = null;
    const baselinePlan = optimizeConnectedBoosts(entries, focal, 5, null);
    const boostedPlan = optimizeConnectedBoosts(entries, focal, 5 + Number(focal.trinket.effect.loadBonus || 0), focal.trinket.effect);
    for (const entry of entries.filter(entry => entry.userId === focal.userId)) entry.boost = boostedPlan[entry.slot] || null;
    focal.baselineBoostPlan = baselinePlan;
  }
  if (family === 'journeyman') {
    const ownNeighbour = entries.find(entry => entry.userId === 1 && adjacentWutSlots(focal.slot).includes(entry.slot));
    const targetKey = ownNeighbour ? `${ownNeighbour.player.season}|${ownNeighbour.player.team}` : '';
    if (targetKey) forceChemistryStack(entries, players, 1, ownNeighbour, 3, random, targetKey, [focal]);
    if (['epic', 'legendary'].includes(rarity)) forceChemistryStack(entries, players, 2, opposite, 3 + Math.floor(random() * 3), random, targetKey);
  }
  if (family === 'warding_charm') {
    const opposingRarity = pick(WUT_RARITIES, random);
    opposite.trinket = trinket(random() < .5 ? 'hex_bag' : 'siphon_stone', opposingRarity);
    opposite.power = opposite.player.cardPower + WUT_RARITIES.indexOf(opposingRarity) + 1;
  }
  if (family === 'zebra_stripes') {
    const targetFamily = pick(SELF_TARGETS, random);
    const targetRarity = pick(WUT_RARITIES, random);
    opposite.trinket = trinket(targetFamily, targetRarity);
    opposite.power = opposite.player.cardPower + WUT_RARITIES.indexOf(targetRarity) + 1;
    if (targetFamily === 'first_strike_tape') opposite.committedAt = focal.committedAt - 1;
    if (targetFamily === 'counterpunch_gloves') opposite.committedAt = focal.committedAt + 1;
    if (targetFamily === 'team_crest') forceChemistryStack(entries, players, 2, opposite, 2 + Math.floor(random() * 4), random);
    if (targetFamily === 'booster_cable') opposite.boost = randomBoost(opposite.player.position, 3, random);
  }
  return focal;
}

function summarizeCore(rows) {
  const swings = rows.map(row => row.swing);
  const triggered = swings.filter(value => Math.abs(value) > 1e-9);
  const owner = rows.map(row => row.owner);
  const suppressed = rows.map(row => row.suppressed);
  return {
    meanMarginSwing: mean(swings),
    medianMarginSwing: percentile(swings, .5),
    p10MarginSwing: percentile(swings, .1),
    p90MarginSwing: percentile(swings, .9),
    meanOwnerFp: mean(owner),
    meanOpponentFpSuppressed: mean(suppressed),
    meanTriggeredMarginSwing: mean(triggered),
    meanMarginSwingPctOfBaseCard: mean(rows.map(row => row.baseCardFp > 0 ? row.swing / row.baseCardFp : 0)),
    triggerRate: rows.filter(row => Math.abs(row.swing) > 1e-9).length / rows.length,
    downsideRate: rows.filter(row => row.swing < -1e-9).length / rows.length,
    favorableWinFlipRate: rows.filter(row => row.baseMargin <= 0 && row.withMargin > 0).length / rows.length,
    outcomeFlipRate: rows.filter(row => Math.sign(row.baseMargin) !== Math.sign(row.withMargin)).length / rows.length,
    meanBaseCardFp: mean(rows.map(row => row.baseCardFp))
  };
}

function groupedSummary(rows, key) {
  return Object.fromEntries([...new Set(rows.map(row => row[key]))].filter(Boolean).map(value => [value, summarizeCore(rows.filter(row => row[key] === value))]));
}

function summarize(rows) {
  return {
    ...summarizeCore(rows),
    byEdition: groupedSummary(rows, 'edition'),
    byPosition: groupedSummary(rows, 'position'),
    byVolatility: groupedSummary(rows, 'volatilityBand')
  };
}

async function main() {
  const players = await loadPool();
  const results = {};
  const families = Object.keys(WUT_LAUNCH_TRINKET_EFFECTS).filter(family => !FAMILY_FILTER.length || FAMILY_FILTER.includes(family));
  for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
    const family = families[familyIndex];
    results[family] = {};
    for (let rarityIndex = 0; rarityIndex < WUT_RARITIES.length; rarityIndex += 1) {
      const rarity = WUT_RARITIES[rarityIndex];
      // Every rarity sees the same base scenario stream. This makes rarity
      // comparisons paired rather than depending on five independent samples.
      const random = mulberry32(SEED + familyIndex * 100003);
      const rows = [];
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const entries = buildMatch(players, random);
        const focal = prepareScenario(entries, players, family, rarity, random);
        const withTrinket = scoreMatch(entries, random);
        const baselineEntries = structuredClone(entries);
        const baselineFocal = baselineEntries.find(entry => entry.userId === focal.userId && entry.slot === focal.slot);
        baselineFocal.trinket = null;
        if (family === 'booster_cable' && focal.baselineBoostPlan) {
          for (const entry of baselineEntries.filter(entry => entry.userId === focal.userId)) {
            entry.boost = focal.baselineBoostPlan[entry.slot] || null;
          }
        }
        const baseline = scoreMatch(baselineEntries, random);
        const withTotals = totals(withTrinket);
        const baseTotals = totals(baseline);
        const withFocal = withTrinket.find(entry => entry.userId === focal.userId && entry.slot === focal.slot);
        const baseFocal = baseline.find(entry => entry.userId === focal.userId && entry.slot === focal.slot);
        rows.push({
          swing: withTotals.margin - baseTotals.margin,
          owner: withTotals.one - baseTotals.one,
          suppressed: baseTotals.two - withTotals.two,
          baseCardFp: baseFocal.finalFp,
          focalGain: withFocal.finalFp - baseFocal.finalFp,
          baseMargin: baseTotals.margin,
          withMargin: withTotals.margin,
          edition: focal.player.edition,
          position: focal.player.position,
          volatilityBand: focal.player.volatilityBand
        });
      }
      results[family][rarity] = summarize(rows);
    }
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    trialsPerFamilyRarity: TRIALS,
    source: 'Complete local S1, S2, S3, and Mythic WUT card catalog',
    catalog: players.meta,
    players: players.length,
    games: players.reduce((sum, player) => sum + player.games.length, 0),
    cardsByEdition: Object.fromEntries([...new Set(players.map(player => player.edition))].map(edition => [edition, players.filter(player => player.edition === edition).length])),
    cardsByPosition: Object.fromEntries(['F', 'D', 'G'].map(position => [position, players.filter(player => player.position === position).length])),
    adjacency: WUT_LINEUP_SLOTS,
    results
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT}`);
  console.log(`Seed ${SEED}; ${TRIALS} trials x ${Object.keys(results).length} families x ${WUT_RARITIES.length} rarities.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
