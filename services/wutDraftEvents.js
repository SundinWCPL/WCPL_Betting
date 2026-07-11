import { isPlayerPackEligible } from './cards.js';

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const POSITIONS = ['F', 'D', 'G'];
const FORMATS = ['round_robin', 'swiss', 'single_elimination', 'swiss_top_cut'];
const BENCH_MODES = ['shared_vote', 'random_shared', 'preset_shared', 'disabled'];
const CURRENCIES = ['wut_coin', 'mushybux', 'free'];
export const WUT_EVENT_TIME_ZONE = 'America/Los_Angeles';

export const WUT_DRAFT_PHASES = Object.freeze([
  'scheduled', 'signup_open', 'signup_closed', 'starting', 'bench_vote',
  'draft', 'deckbuilding', 'tournament', 'complete', 'prizes_awarded', 'cancelled'
]);

export function isWutDraftEventLobbyVisible(event) {
  const phase = String(event?.phase || '');
  if (phase === 'cancelled') return false;
  if (phase === 'complete') return true;
  if (phase === 'prizes_awarded') {
    return (event?.prizes?.awards || []).some(award =>
      award?.type === 'player_pack' && !['claimed'].includes(String(award.status || ''))
    );
  }
  return true;
}

export function selectWutDraftEliminationBye(seededUserIds, standings = [], previousByeUserIds = []) {
  const seeded = (seededUserIds || []).map(Number).filter(Number.isFinite);
  if (!seeded.length || seeded.length % 2 === 0) return null;
  const previous = new Set((previousByeUserIds || []).map(Number));
  const withoutPreviousBye = seeded.filter(userId => !previous.has(userId));
  const candidates = withoutPreviousBye.length ? withoutPreviousBye : seeded;
  const rows = new Map((standings || []).map(row => [Number(row.user_id), row]));
  const unequalMatchCounts = new Set(candidates.map(userId => Number(rows.get(userId)?.played || 0))).size > 1;
  return [...candidates].sort((a, b) => {
    const first = rows.get(a) || {}; const second = rows.get(b) || {};
    const firstPlayed = Number(first.played || 0); const secondPlayed = Number(second.played || 0);
    const firstTotal = Number(first.fp_for || 0); const secondTotal = Number(second.fp_for || 0);
    const firstPerformance = unequalMatchCounts ? (firstPlayed ? firstTotal / firstPlayed : 0) : firstTotal;
    const secondPerformance = unequalMatchCounts ? (secondPlayed ? secondTotal / secondPlayed : 0) : secondTotal;
    return secondPerformance - firstPerformance || secondTotal - firstTotal || seeded.indexOf(a) - seeded.indexOf(b);
  })[0];
}

export const WUT_DRAFT_TRANSITIONS = Object.freeze({
  scheduled: ['signup_open', 'signup_closed', 'cancelled'],
  signup_open: ['signup_closed', 'cancelled'],
  signup_closed: ['signup_open', 'starting', 'cancelled'],
  starting: ['draft', 'cancelled'],
  bench_vote: ['draft', 'cancelled'],
  draft: ['deckbuilding', 'cancelled'],
  deckbuilding: ['tournament', 'cancelled'],
  tournament: ['complete', 'cancelled'],
  complete: ['prizes_awarded'],
  prizes_awarded: [],
  cancelled: []
});

const DEFAULT_ODDS = Object.freeze({ common: 55, uncommon: 25, rare: 13, epic: 6, legendary: 1 });
const DEFAULT_BENCH_POSITIONS = Object.freeze({
  F: { candidates: 4, winners: 2 },
  D: { candidates: 4, winners: 2 },
  G: { candidates: 2, winners: 1 }
});

export const NIGHTLY_WUT_DRAFT_PRESET = Object.freeze({
  key: 'nightly-booster-draft',
  name: 'Nightly Booster Draft',
  description: 'The standard configurable WUT live booster draft.',
  config: {
    basic: {
      name: 'Nightly Booster Draft', description: 'Draft a temporary collection and play a live WUT tournament.',
      entryFee: { amount: 500, currency: 'wut_coin' }, minimumEntrants: 4, maximumEntrants: 8,
      allowOddEntrants: true, visibility: 'public', automaticStart: true, allowManualStartBelowMinimum: false
    },
    signup: { allowWithdrawal: true, allowLateSignup: false, automaticClose: true },
    safetyBench: {
      mode: 'disabled', votingSeconds: 60, rarityMin: 'common', rarityMax: 'common',
      positions: DEFAULT_BENCH_POSITIONS, presetCards: []
    },
    boosters: {
      countPerPlayer: 3, contents: { players: 6, boosts: 2, trinkets: 2 },
      rarityOdds: { players: DEFAULT_ODDS, boosts: DEFAULT_ODDS, trinkets: DEFAULT_ODDS },
      guarantees: { rarePlusPlayerPerBooster: false, trinketRarity: null },
      rarityLimits: {
        players: { minimum: 'common', maximum: 'legendary' },
        boosts: { minimum: 'common', maximum: 'legendary' },
        trinkets: { minimum: 'common', maximum: 'legendary' }
      },
      pool: {
        allowDuplicateInBooster: false, allowDuplicateInEvent: true,
        seasons: ['S1', 'S2', 'S3'], divisions: [], positions: POSITIONS, rarities: RARITIES
      }
    },
    draft: {
      pickSeconds: 60, passDirections: ['left', 'right', 'left'],
      autopick: { enabled: true, priority: ['rarity', 'player', 'trinket', 'boost', 'random'] }
    },
    deckbuilding: {
      seconds: 600, activeMinimum: 8, activeMaximum: 8, deckSize: 8, topLineupMaxPower: 15, requirePositions: false, lockDeckForTournament: true,
      sideboardingBetweenRounds: false, lockTrinketAttachments: true, allowTrinketReassignment: false
    },
    tournament: {
      format: 'swiss', automaticNextRound: true, betweenRoundSeconds: 120,
      roundRobin: { meetings: 1, byeCountsAsWin: true, tiebreakers: ['head_to_head', 'fp_differential', 'fp_scored', 'random'] },
      swiss: { rounds: 3, avoidRematches: true, byeCountsAsWin: true, tiebreakers: ['match_wins', 'opponent_wins', 'fp_differential', 'fp_scored', 'random'] },
      elimination: { seeding: 'random', adminSeedUserIds: [], thirdPlaceMatch: false, consolationMatch: false },
      topCut: { swissRounds: 3, advancing: 4, seeding: 'standings' }
    },
    match: {
      turnSeconds: 600, openingTimeout: 'forfeit', laterTimeout: 'forfeit', overnightPause: false,
      boostLoadCap: 5, boostsMode: 'tournament_consumable', simultaneousMatches: true
    },
    prizes: {
      tiers: [
        { key: 'first', label: '1st', places: [1], rewards: [{ type: 'player_pack', packType: 'prestige', quantity: 1 }] },
        { key: 'second', label: '2nd', places: [2], rewards: [{ type: 'player_pack', packType: 'premium', quantity: 1 }] },
        { key: 'third', label: '3rd', places: [3], rewards: [{ type: 'player_pack', packType: 'standard', quantity: 1 }] }
      ]
    },
    scheduling: { signupOpensAt: null, signupClosesAt: null, startsAt: null, recurring: null }
  }
});

const clone = value => JSON.parse(JSON.stringify(value));

export function snapshotWutDraftCard(card) {
  return clone({
    cardIdentity: card.cardIdentity, catalogKey: card.catalogKey, cardType: card.cardType,
    edition: card.edition, sourceSeason: card.sourceSeason, sourceStage: card.sourceStage,
    divisionId: card.divisionId, sourceDivisionId: card.sourceDivisionId,
    playerKey: card.playerKey, sourcePlayerKey: card.sourcePlayerKey,
    steamId: card.steamId, sourceSteamId: card.sourceSteamId,
    baseName: card.baseName, displayName: card.displayName,
    sourceType: card.sourceType, manualRates: card.manualRates,
    sourceTeamId: card.sourceTeamId, teamId: card.teamId, teamName: card.teamName,
    teamLogo: card.teamLogo, teamBgColor: card.teamBgColor, teamTextColor: card.teamTextColor,
    position: card.position, tier: card.tier, stars: card.stars,
    weightedFpPerGame: card.weightedFpPerGame, expectedWutFpPerMatch: card.expectedWutFpPerMatch,
    editionStats: card.editionStats, scoringPool: card.scoringPool || null,
    unavailableStats: card.unavailableStats || []
  });
}

export function hydrateWutDraftCardPlayer(snapshot, catalogPlayer = null) {
  const frozen = snapshot || {};
  const canonical = catalogPlayer || {};
  const playerKeyName = String(frozen.sourcePlayerKey || frozen.playerKey || canonical.sourcePlayerKey || canonical.playerKey || '')
    .replace(/^name:/i, '').trim();
  return {
    ...canonical,
    ...frozen,
    sourceSteamId: frozen.sourceSteamId || frozen.steamId || canonical.sourceSteamId || canonical.steamId || '',
    steamId: frozen.steamId || frozen.sourceSteamId || canonical.steamId || canonical.sourceSteamId || '',
    sourcePlayerKey: frozen.sourcePlayerKey || frozen.playerKey || canonical.sourcePlayerKey || canonical.playerKey || '',
    sourceDivisionId: frozen.sourceDivisionId || frozen.divisionId || canonical.sourceDivisionId || canonical.divisionId || '',
    baseName: frozen.baseName || canonical.baseName || playerKeyName || frozen.displayName || canonical.displayName || '',
    name: frozen.displayName || frozen.name || canonical.displayName || canonical.name || ''
  };
}
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const boolean = (value, fallback) => value == null ? fallback : value === true || value === 'true' || value === 1 || value === '1';
const text = (value, fallback = '', max = 500) => String(value ?? fallback).trim().slice(0, max);
const integer = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};
const choice = (value, allowed, fallback) => allowed.includes(String(value)) ? String(value) : fallback;
const uniqueChoices = (value, allowed, fallback) => {
  const clean = Array.isArray(value) ? [...new Set(value.map(String).filter(item => allowed.includes(item)))] : [];
  return clean.length ? clean : [...fallback];
};
const rarityIndex = value => RARITIES.indexOf(value);

export function wutPacificDateTimeToIso(value, label = 'Date and time') {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date and time.`);
    return value.toISOString();
  }
  const clean = String(value).trim();
  const wallTime = clean.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (wallTime) {
    const [, year, month, day, hour, minute, second = '0'] = wallTime;
    const desired = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    let guess = desired;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: WUT_EVENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    for (let index = 0; index < 4; index += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
        .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
      const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      guess += desired - actual;
    }
    const resolved = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    if (resolved.year !== Number(year) || resolved.month !== Number(month) || resolved.day !== Number(day) ||
        resolved.hour !== Number(hour) || resolved.minute !== Number(minute) || resolved.second !== Number(second)) {
      throw new Error(`${label} does not exist in Pacific Time because of the daylight-saving clock change.`);
    }
    return new Date(guess).toISOString();
  }
  const date = new Date(clean);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date and time.`);
  return date.toISOString();
}

function normalizedIso(value, label) {
  return wutPacificDateTimeToIso(value, label);
}

function normalizedOdds(value, fallback = DEFAULT_ODDS) {
  const source = object(value);
  const explicitlyConfigured = Object.keys(source).length > 0;
  const odds = Object.fromEntries(RARITIES.map(rarity => [rarity, Math.max(0, Number(source[rarity] ?? (explicitlyConfigured ? 0 : fallback[rarity]) ?? 0))]));
  if (!Object.values(odds).some(weight => weight > 0)) throw new Error('Each enabled draft rarity table needs at least one positive weight.');
  return odds;
}

function normalizedRarityRange(value, fallback) {
  const source = object(value);
  const minimum = choice(source.minimum, RARITIES, fallback.minimum);
  const maximum = choice(source.maximum, RARITIES, fallback.maximum);
  if (rarityIndex(minimum) > rarityIndex(maximum)) throw new Error('Draft minimum rarity cannot exceed maximum rarity.');
  return { minimum, maximum };
}

function normalizeRewards(value) {
  return (Array.isArray(value) ? value : []).map((reward, index) => {
    const source = object(reward);
    const type = choice(source.type, ['player_pack', 'wut_coins', 'random_trinket', 'specific_trinket'], 'wut_coins');
    const normalized = { type, quantity: integer(source.quantity, 1, 1, 100) };
    if (type === 'player_pack') normalized.packType = choice(source.packType, ['standard', 'premium', 'prestige'], 'standard');
    if (type === 'wut_coins') normalized.amount = integer(source.amount, 0, 0, 100000000);
    if (type === 'random_trinket') normalized.rarity = source.rarity == null || source.rarity === 'any' ? 'any' : choice(source.rarity, RARITIES, 'common');
    if (type === 'specific_trinket') {
      normalized.family = text(source.family, '', 80);
      normalized.rarity = choice(source.rarity, RARITIES, 'common');
      if (!normalized.family) throw new Error(`Prize reward ${index + 1} needs a trinket family.`);
    }
    return normalized;
  });
}

export function normalizeWutDraftEventConfig(input = {}) {
  const defaults = clone(NIGHTLY_WUT_DRAFT_PRESET.config);
  const source = object(input);
  const basic = object(source.basic);
  const signup = object(source.signup);
  const safetyBench = object(source.safetyBench);
  const boosters = object(source.boosters);
  const draft = object(source.draft);
  const deckbuilding = object(source.deckbuilding);
  const tournament = object(source.tournament);
  const match = object(source.match);
  const prizes = object(source.prizes);
  const scheduling = object(source.scheduling);

  const minimumEntrants = integer(basic.minimumEntrants, defaults.basic.minimumEntrants, 2, 256);
  const maximumEntrants = basic.maximumEntrants == null || basic.maximumEntrants === ''
    ? null : integer(basic.maximumEntrants, defaults.basic.maximumEntrants, 2, 256);
  if (maximumEntrants != null && maximumEntrants < minimumEntrants) throw new Error('Maximum entrants cannot be below minimum entrants.');
  const entryCurrency = choice(basic.entryFee?.currency, CURRENCIES, defaults.basic.entryFee.currency);
  const entryAmount = entryCurrency === 'free' ? 0 : integer(basic.entryFee?.amount, defaults.basic.entryFee.amount, 0, 100000000);
  const boosterCount = integer(boosters.countPerPlayer, defaults.boosters.countPerPlayer, 1, 20);
  const boosterContents = {
    players: integer(boosters.contents?.players, defaults.boosters.contents.players, 0, 30),
    boosts: integer(boosters.contents?.boosts, defaults.boosters.contents.boosts, 0, 30),
    trinkets: integer(boosters.contents?.trinkets, defaults.boosters.contents.trinkets, 0, 30)
  };
  if (!Object.values(boosterContents).some(count => count > 0)) throw new Error('Each event booster must contain at least one item.');
  const rarePlusGuarantee = boolean(boosters.guarantees?.rarePlusPlayerPerBooster, defaults.boosters.guarantees.rarePlusPlayerPerBooster);
  const guaranteedTrinketRarity = boosters.guarantees?.trinketRarity == null ? null : choice(boosters.guarantees.trinketRarity, RARITIES, null);
  const requestedDirections = Array.isArray(draft.passDirections) ? draft.passDirections : defaults.draft.passDirections;
  const passDirections = Array.from({ length: boosterCount }, (_, index) => choice(requestedDirections[index % requestedDirections.length], ['left', 'right'], index % 2 ? 'right' : 'left'));
  const deckSize = integer(deckbuilding.deckSize ?? deckbuilding.activeMaximum, defaults.deckbuilding.deckSize, 1, 30);
  const activeMinimum = deckSize;
  const activeMaximum = deckSize;
  const topLineupMaxPower = Number(deckbuilding.topLineupMaxPower ?? defaults.deckbuilding.topLineupMaxPower);
  const requirePositions = boolean(deckbuilding.requirePositions, defaults.deckbuilding.requirePositions);
  if (!Number.isFinite(topLineupMaxPower) || topLineupMaxPower <= 0) throw new Error('Event top lineup Power cap must be greater than 0.');
  if (activeMinimum > activeMaximum) throw new Error('Event Active Deck minimum cannot exceed its maximum.');

  const benchPositions = Object.fromEntries(POSITIONS.map(position => {
    const positionSource = object(safetyBench.positions?.[position]);
    const fallback = defaults.safetyBench.positions[position];
    const candidates = integer(positionSource.candidates, fallback.candidates, 1, 30);
    const winners = integer(positionSource.winners, fallback.winners, 1, candidates);
    return [position, { candidates, winners }];
  }));
  const format = choice(tournament.format, FORMATS, defaults.tournament.format);
  const signupOpensAt = normalizedIso(scheduling.signupOpensAt, 'Signup opening');
  const signupClosesAt = normalizedIso(scheduling.signupClosesAt, 'Signup closing');
  const startsAt = normalizedIso(scheduling.startsAt, 'Event start');
  if (signupOpensAt && signupClosesAt && signupOpensAt >= signupClosesAt) throw new Error('Signup must close after it opens.');
  if (signupClosesAt && startsAt && signupClosesAt > startsAt && !boolean(signup.allowLateSignup, defaults.signup.allowLateSignup)) {
    throw new Error('Event start cannot precede signup close unless late signup is enabled.');
  }

  const tiers = (Array.isArray(prizes.tiers) ? prizes.tiers : defaults.prizes.tiers).map((tier, index) => {
    const tierSource = object(tier);
    const places = [...new Set((Array.isArray(tierSource.places) ? tierSource.places : []).map(place => integer(place, 1, 1, 256)))].sort((a, b) => a - b);
    const participant = tierSource.participant === true || tierSource.key === 'participants';
    if (!participant && !places.length) throw new Error(`Prize tier ${index + 1} needs at least one place.`);
    return {
      key: text(tierSource.key, `tier-${index + 1}`, 60), label: text(tierSource.label, `Prize ${index + 1}`, 80),
      places, participant, rewards: normalizeRewards(tierSource.rewards)
    };
  });

  return {
    basic: {
      name: text(basic.name, defaults.basic.name, 100), description: text(basic.description, defaults.basic.description, 2000),
      entryFee: { amount: entryAmount, currency: entryCurrency }, minimumEntrants, maximumEntrants,
      allowOddEntrants: boolean(basic.allowOddEntrants, defaults.basic.allowOddEntrants),
      visibility: choice(basic.visibility, ['public', 'private', 'admin_only'], defaults.basic.visibility),
      automaticStart: boolean(basic.automaticStart, defaults.basic.automaticStart),
      allowManualStartBelowMinimum: boolean(basic.allowManualStartBelowMinimum, defaults.basic.allowManualStartBelowMinimum)
    },
    signup: {
      allowWithdrawal: boolean(signup.allowWithdrawal, defaults.signup.allowWithdrawal),
      allowLateSignup: boolean(signup.allowLateSignup, defaults.signup.allowLateSignup),
      automaticClose: boolean(signup.automaticClose, defaults.signup.automaticClose)
    },
    safetyBench: {
      mode: choice(safetyBench.mode, BENCH_MODES, defaults.safetyBench.mode),
      votingSeconds: integer(safetyBench.votingSeconds, defaults.safetyBench.votingSeconds, 5, 86400),
      rarityMin: 'common', rarityMax: 'common', positions: benchPositions,
      presetCards: Array.isArray(safetyBench.presetCards) ? [...new Set(safetyBench.presetCards.map(String))] : []
    },
    boosters: {
      countPerPlayer: boosterCount,
      contents: boosterContents,
      rarityOdds: {
        players: normalizedOdds(boosters.rarityOdds?.players, defaults.boosters.rarityOdds.players),
        boosts: normalizedOdds(boosters.rarityOdds?.boosts, defaults.boosters.rarityOdds.boosts),
        trinkets: normalizedOdds(boosters.rarityOdds?.trinkets, defaults.boosters.rarityOdds.trinkets)
      },
      guarantees: {
        rarePlusPlayerPerBooster: rarePlusGuarantee,
        trinketRarity: guaranteedTrinketRarity
      },
      rarityLimits: {
        players: normalizedRarityRange(boosters.rarityLimits?.players, defaults.boosters.rarityLimits.players),
        boosts: normalizedRarityRange(boosters.rarityLimits?.boosts, defaults.boosters.rarityLimits.boosts),
        trinkets: normalizedRarityRange(boosters.rarityLimits?.trinkets, defaults.boosters.rarityLimits.trinkets)
      },
      pool: {
        allowDuplicateInBooster: boolean(boosters.pool?.allowDuplicateInBooster, defaults.boosters.pool.allowDuplicateInBooster),
        allowDuplicateInEvent: boolean(boosters.pool?.allowDuplicateInEvent, defaults.boosters.pool.allowDuplicateInEvent),
        seasons: uniqueChoices(boosters.pool?.seasons, ['S1', 'S2', 'S3', 'MYTHIC'], defaults.boosters.pool.seasons),
        divisions: Array.isArray(boosters.pool?.divisions) ? [...new Set(boosters.pool.divisions.map(String).filter(Boolean))] : [],
        positions: uniqueChoices(boosters.pool?.positions, POSITIONS, defaults.boosters.pool.positions),
        rarities: uniqueChoices(boosters.pool?.rarities, RARITIES, defaults.boosters.pool.rarities)
      }
    },
    draft: {
      pickSeconds: integer(draft.pickSeconds, defaults.draft.pickSeconds, 5, 86400), passDirections,
      autopick: {
        enabled: boolean(draft.autopick?.enabled, defaults.draft.autopick.enabled),
        priority: uniqueChoices(draft.autopick?.priority, ['rarity', 'player', 'trinket', 'boost', 'random'], defaults.draft.autopick.priority)
      }
    },
    deckbuilding: {
      seconds: integer(deckbuilding.seconds, defaults.deckbuilding.seconds, 30, 604800), activeMinimum, activeMaximum,
      deckSize, topLineupMaxPower, requirePositions,
      lockDeckForTournament: boolean(deckbuilding.lockDeckForTournament, defaults.deckbuilding.lockDeckForTournament),
      sideboardingBetweenRounds: boolean(deckbuilding.sideboardingBetweenRounds, defaults.deckbuilding.sideboardingBetweenRounds),
      lockTrinketAttachments: boolean(deckbuilding.lockTrinketAttachments, defaults.deckbuilding.lockTrinketAttachments),
      allowTrinketReassignment: boolean(deckbuilding.allowTrinketReassignment, defaults.deckbuilding.allowTrinketReassignment)
    },
    tournament: {
      format, automaticNextRound: boolean(tournament.automaticNextRound, defaults.tournament.automaticNextRound),
      betweenRoundSeconds: integer(tournament.betweenRoundSeconds, defaults.tournament.betweenRoundSeconds, 0, 86400),
      roundRobin: {
        meetings: integer(tournament.roundRobin?.meetings, defaults.tournament.roundRobin.meetings, 1, 20),
        byeCountsAsWin: boolean(tournament.roundRobin?.byeCountsAsWin, defaults.tournament.roundRobin.byeCountsAsWin),
        tiebreakers: uniqueChoices(tournament.roundRobin?.tiebreakers, ['head_to_head', 'match_wins', 'fp_differential', 'fp_scored', 'random'], defaults.tournament.roundRobin.tiebreakers)
      },
      swiss: {
        rounds: integer(tournament.swiss?.rounds, defaults.tournament.swiss.rounds, 1, 30),
        avoidRematches: boolean(tournament.swiss?.avoidRematches, defaults.tournament.swiss.avoidRematches),
        byeCountsAsWin: boolean(tournament.swiss?.byeCountsAsWin, defaults.tournament.swiss.byeCountsAsWin),
        tiebreakers: uniqueChoices(tournament.swiss?.tiebreakers, ['match_wins', 'opponent_wins', 'fp_differential', 'fp_scored', 'random'], defaults.tournament.swiss.tiebreakers)
      },
      elimination: {
        seeding: choice(tournament.elimination?.seeding, ['random', 'wut_elo', 'draft_order', 'signup_order', 'admin'], defaults.tournament.elimination.seeding),
        adminSeedUserIds: Array.isArray(tournament.elimination?.adminSeedUserIds) ? [...new Set(tournament.elimination.adminSeedUserIds.map(Number).filter(Number.isInteger))] : [],
        thirdPlaceMatch: boolean(tournament.elimination?.thirdPlaceMatch, defaults.tournament.elimination.thirdPlaceMatch),
        consolationMatch: boolean(tournament.elimination?.consolationMatch, defaults.tournament.elimination.consolationMatch)
      },
      topCut: {
        swissRounds: integer(tournament.topCut?.swissRounds, defaults.tournament.topCut.swissRounds, 1, 30),
        advancing: integer(tournament.topCut?.advancing, defaults.tournament.topCut.advancing, 2, 128),
        seeding: choice(tournament.topCut?.seeding, ['standings', 'random', 'wut_elo'], defaults.tournament.topCut.seeding)
      }
    },
    match: {
      turnSeconds: integer(match.turnSeconds, defaults.match.turnSeconds, 15, 604800),
      openingTimeout: choice(match.openingTimeout, ['forfeit', 'cancel', 'autoplay'], defaults.match.openingTimeout),
      laterTimeout: choice(match.laterTimeout, ['forfeit', 'autoplay'], defaults.match.laterTimeout),
      overnightPause: boolean(match.overnightPause, defaults.match.overnightPause),
      boostLoadCap: integer(match.boostLoadCap, defaults.match.boostLoadCap, 0, 100),
      boostsMode: choice(match.boostsMode, ['tournament_consumable', 'refresh_each_match'], defaults.match.boostsMode),
      simultaneousMatches: boolean(match.simultaneousMatches, defaults.match.simultaneousMatches)
    },
    prizes: { tiers },
    scheduling: { signupOpensAt, signupClosesAt, startsAt, recurring: scheduling.recurring == null ? null : clone(scheduling.recurring) }
  };
}

function weightedRarity(odds, allowed, random = Math.random) {
  const weighted = allowed.map(rarity => [rarity, Math.max(0, Number(odds?.[rarity] || 0))]);
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return allowed[0];
  let roll = Math.max(0, Math.min(0.999999999, Number(random()))) * total;
  for (const [rarity, weight] of weighted) {
    roll -= weight;
    if (roll < 0) return rarity;
  }
  return weighted.at(-1)[0];
}

export function buildWutDraftBoosterRoundTemplates(config, random = Math.random) {
  const normalized = normalizeWutDraftEventConfig(config);
  const templates = [];
  for (let boosterIndex = 0; boosterIndex < normalized.boosters.countPerPlayer; boosterIndex += 1) {
    const slots = [];
    for (const [itemType, count, oddsKey] of [
      ['player', normalized.boosters.contents.players, 'players'],
      ['boost', normalized.boosters.contents.boosts, 'boosts'],
      ['trinket', normalized.boosters.contents.trinkets, 'trinkets']
    ]) {
      const range = normalized.boosters.rarityLimits[oddsKey];
      const allowed = normalized.boosters.pool.rarities.filter(rarity =>
        rarityIndex(rarity) >= rarityIndex(range.minimum) && rarityIndex(rarity) <= rarityIndex(range.maximum)
      );
      if (count > 0 && !allowed.length) throw new Error(`No rarities are eligible for draft ${oddsKey}.`);
      for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
        slots.push({
          slot: `${itemType}-${slotIndex + 1}`, itemType,
          rarity: weightedRarity(normalized.boosters.rarityOdds[oddsKey], allowed, random)
        });
      }
    }
    const playerSlots = slots.filter(slot => slot.itemType === 'player');
    if (normalized.boosters.guarantees.rarePlusPlayerPerBooster && playerSlots.length && !playerSlots.some(slot => rarityIndex(slot.rarity) >= rarityIndex('rare'))) {
      const range = normalized.boosters.rarityLimits.players;
      const rarePlus = normalized.boosters.pool.rarities.filter(rarity =>
        rarityIndex(rarity) >= Math.max(rarityIndex('rare'), rarityIndex(range.minimum)) && rarityIndex(rarity) <= rarityIndex(range.maximum)
      );
      if (!rarePlus.length) throw new Error('Rare+ player guarantee is incompatible with the configured rarity limits.');
      playerSlots.at(-1).rarity = weightedRarity(normalized.boosters.rarityOdds.players, rarePlus, random);
    }
    const trinketSlots = slots.filter(slot => slot.itemType === 'trinket');
    if (normalized.boosters.guarantees.trinketRarity) {
      if (!trinketSlots.length) throw new Error('A guaranteed trinket rarity requires at least one trinket per booster.');
      const guaranteed = normalized.boosters.guarantees.trinketRarity;
      const range = normalized.boosters.rarityLimits.trinkets;
      if (!normalized.boosters.pool.rarities.includes(guaranteed) || rarityIndex(guaranteed) < rarityIndex(range.minimum) || rarityIndex(guaranteed) > rarityIndex(range.maximum)) {
        throw new Error('Guaranteed trinket rarity is incompatible with the configured rarity limits.');
      }
      trinketSlots.at(-1).rarity = guaranteed;
    }
    templates.push({
      boosterNumber: boosterIndex + 1,
      passDirection: normalized.draft.passDirections[boosterIndex],
      slots
    });
  }
  return templates;
}

export function instantiateWutDraftBoosterTemplate(template, entrantIds) {
  return (entrantIds || []).map((userId, seat) => ({
    seat, user_id: Number(userId), booster_number: Number(template.boosterNumber),
    pass_direction: template.passDirection, composition: clone(template.slots), items: []
  }));
}

function randomItem(values, random = Math.random) {
  if (!values.length) return null;
  return values[Math.floor(Math.max(0, Math.min(.999999999, Number(random()))) * values.length)];
}

export function materializeWutDraftBoosterRound({
  template, entrantIds, cards, boostEffects, trinketEffects, poolRules = {},
  usedCardIdentities = new Set(), random = Math.random
}) {
  const roundUsedCards = new Set();
  const boostTypes = Object.keys(boostEffects || {}).filter(type => !['hit', 'block'].includes(type));
  const trinketFamilies = Object.keys(trinketEffects || {});
  if (template.slots.some(slot => slot.itemType === 'boost') && !boostTypes.length) throw new Error('No boost definitions are available for this Draft Event.');
  if (template.slots.some(slot => slot.itemType === 'trinket') && !trinketFamilies.length) throw new Error('No trinket definitions are available for this Draft Event.');
  return (entrantIds || []).map((userId, seat) => {
    const packUsedCards = new Set();
    const items = template.slots.map(slot => {
      if (slot.itemType === 'player') {
        const basePool = (cards || []).filter(card => card.tier === slot.rarity && (!usedCardIdentities.has(card.cardIdentity) || poolRules.allowDuplicateInEvent !== false));
        const legal = basePool.filter(card =>
          (poolRules.allowDuplicateInBooster !== false || !packUsedCards.has(card.cardIdentity)) &&
          !roundUsedCards.has(card.cardIdentity)
        );
        const fallback = basePool.filter(card => poolRules.allowDuplicateInBooster !== false || !packUsedCards.has(card.cardIdentity));
        const card = randomItem(legal.length ? legal : (poolRules.allowDuplicateInEvent !== false ? fallback : []), random);
        if (!card) throw new Error(`Not enough unique ${slot.rarity} player cards to generate this Draft Event booster round.`);
        packUsedCards.add(card.cardIdentity);
        roundUsedCards.add(card.cardIdentity);
        usedCardIdentities.add(card.cardIdentity);
        return { slot: slot.slot, item_type: 'player', rarity: slot.rarity, card_identity: card.cardIdentity, player_snapshot: clone(card) };
      }
      if (slot.itemType === 'boost') {
        const boostType = randomItem(boostTypes, random);
        return { slot: slot.slot, item_type: 'boost', rarity: slot.rarity, boost_type: boostType, effect: clone(boostEffects[boostType]?.[slot.rarity] || {}) };
      }
      const family = randomItem(trinketFamilies, random);
      return { slot: slot.slot, item_type: 'trinket', rarity: slot.rarity, family, effect: clone(trinketEffects[family]?.[slot.rarity] || {}) };
    });
    return {
      seat, original_owner_user_id: Number(userId), current_owner_user_id: Number(userId),
      booster_number: Number(template.boosterNumber), pass_direction: template.passDirection,
      items, awaiting_pass: false, opened_at: null, emptied_at: null, pass_count: 0, history: []
    };
  });
}

export function chooseWutDraftAutopick(items, priority = ['rarity', 'player', 'trinket', 'boost', 'random'], random = Math.random) {
  const rarityRank = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 };
  const typeOrder = Object.fromEntries(priority.filter(value => ['player', 'trinket', 'boost'].includes(value)).map((value, index) => [value, index]));
  return [...(items || [])].map(item => ({ item, tie: Number(random()) })).sort((a, b) => {
    for (const rule of priority) {
      if (rule === 'rarity') {
        const difference = (rarityRank[b.item.rarity] || 0) - (rarityRank[a.item.rarity] || 0);
        if (difference) return difference;
      } else if (['player', 'trinket', 'boost'].includes(rule)) {
        const difference = (typeOrder[a.item.item_type] ?? 99) - (typeOrder[b.item.item_type] ?? 99);
        if (difference) return difference;
      } else if (rule === 'random' && a.tie !== b.tie) return a.tie - b.tie;
    }
    return a.tie - b.tie;
  })[0]?.item || null;
}

export function resolveWutDraftEventMatchRecord(match, { action, forfeitingUserId = null, adminUserId = null, reason = '', now = new Date() } = {}) {
  if (!match || !['pending', 'active', 'scoring'].includes(match.status)) throw new Error('Only unresolved Draft Event matches can be changed.');
  const cleanReason = text(reason, 'Admin recovery action', 180);
  if (action === 'void') {
    match.status = 'voided'; match.voided_at = now.toISOString(); match.voided_by = adminUserId == null ? null : Number(adminUserId);
    match.void_reason = cleanReason; match.winner_user_id = null; match.forfeit_user_id = null;
    return { type: 'match_voided', details: { match_id: match.id, reason: cleanReason } };
  }
  if (action === 'forfeit') {
    const forfeiter = Number(forfeitingUserId);
    if (!(match.player_ids || []).map(Number).includes(forfeiter)) throw new Error('Choose a player in this match to forfeit.');
    const winner = (match.player_ids || []).map(Number).find(userId => userId !== forfeiter);
    if (!winner) throw new Error('A forfeit requires an opposing player.');
    match.status = 'completed'; match.winner_user_id = winner; match.forfeit_user_id = forfeiter;
    match.forfeit_reason = cleanReason; match.scores = { [String(winner)]: 1, [String(forfeiter)]: 0 };
    match.completed_at = now.toISOString(); match.resolved_at = now.toISOString();
    return { type: 'match_forfeit_forced', details: { match_id: match.id, forfeiting_user_id: forfeiter, winner_user_id: winner, reason: cleanReason } };
  }
  throw new Error('Unknown Draft Event match recovery action.');
}

export function selectWutDraftBenchPool(config, environmentCards, random = Math.random) {
  const normalized = normalizeWutDraftEventConfig(config);
  const minimum = rarityIndex(normalized.safetyBench.rarityMin);
  const maximum = rarityIndex(normalized.safetyBench.rarityMax);
  const eligible = (environmentCards || []).filter(card =>
    POSITIONS.includes(card.position) && rarityIndex(card.tier) >= minimum && rarityIndex(card.tier) <= maximum
  );
  const shuffle = values => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(Math.max(0, Math.min(.999999999, Number(random()))) * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  };
  const selected = [];
  for (const position of POSITIONS) {
    const count = normalized.safetyBench.positions[position].candidates;
    const pool = eligible.filter(card => card.position === position);
    if (pool.length < count) throw new Error(`Not enough eligible ${position} cards to build the shared Safety Bench pool (${pool.length}/${count}).`);
    selected.push(...shuffle(pool).slice(0, count).map(card => ({ position, card: clone(card) })));
  }
  return selected;
}

export function splitWutDraftCardPools(config, catalog) {
  const normalized = normalizeWutDraftEventConfig(config);
  const pool = normalized.boosters.pool;
  const shared = (catalog || []).filter(card =>
    isPlayerPackEligible(card) &&
    card?.rarityEligible !== false &&
    pool.seasons.includes(card.edition === 'MYTHIC' ? 'MYTHIC' : card.edition) &&
    pool.positions.includes(card.position) &&
    (!pool.divisions.length || pool.divisions.includes(String(card.divisionId)))
  );
  const playerRange = normalized.boosters.rarityLimits.players;
  const playerMinimum = rarityIndex(playerRange.minimum);
  const playerMaximum = rarityIndex(playerRange.maximum);
  return {
    boosterCards: shared.filter(card =>
      pool.rarities.includes(card.tier) &&
      rarityIndex(card.tier) >= playerMinimum && rarityIndex(card.tier) <= playerMaximum
    ),
    benchCards: shared.filter(card => card.tier === 'common')
  };
}

export function resolveWutDraftBenchWinners(config, candidates, votes, random = Math.random) {
  const normalized = normalizeWutDraftEventConfig(config);
  const winners = [];
  for (const position of POSITIONS) {
    const positionCandidates = (candidates || []).filter(candidate => candidate.position === position);
    const counts = new Map(positionCandidates.map(candidate => [candidate.card.cardIdentity, 0]));
    for (const vote of votes || []) {
      for (const identity of vote.selections?.[position] || []) if (counts.has(identity)) counts.set(identity, counts.get(identity) + 1);
    }
    const tieRolls = new Map(positionCandidates.map(candidate => [candidate.card.cardIdentity, Number(random())]));
    positionCandidates.sort((a, b) =>
      (counts.get(b.card.cardIdentity) || 0) - (counts.get(a.card.cardIdentity) || 0) ||
      (tieRolls.get(a.card.cardIdentity) || 0) - (tieRolls.get(b.card.cardIdentity) || 0)
    );
    winners.push(...positionCandidates.slice(0, normalized.safetyBench.positions[position].winners).map(candidate => ({
      ...clone(candidate), votes: counts.get(candidate.card.cardIdentity) || 0
    })));
  }
  return winners;
}

export function appendWutDraftEventLog(event, type, details = {}, { actorUserId = null, now = new Date() } = {}) {
  event.logs = Array.isArray(event.logs) ? event.logs : [];
  const entry = {
    id: Number(event.nextLogId || 1), type: text(type, 'event_note', 80),
    actor_user_id: actorUserId == null ? null : Number(actorUserId), details: clone(details), created_at: now.toISOString()
  };
  event.nextLogId = entry.id + 1;
  event.logs.push(entry);
  return entry;
}

export function createWutDraftEventRecord({ id, config, presetId = null, adminUserId = null, now = new Date() }) {
  const normalized = normalizeWutDraftEventConfig(config);
  if (!normalized.basic.name) throw new Error('Draft event name is required.');
  const event = {
    id: Number(id), preset_id: presetId == null ? null : Number(presetId), phase: 'scheduled', paused_at: null,
    config: normalized, entrants: [], environment_snapshot: null,
    bench: { candidates: [], votes: [], winners: [], deadline_at: null, completed_at: null },
    draft: { boosters: [], picks: [], pass_log: [], round_templates: [], seat_user_ids: [], pending_user_ids: [], current_booster: 0, current_pick: 0, deadline_at: null, completed_at: null },
    inventories: {}, decks: {}, deckbuilding: { deadline_at: null, completed_at: null }, nextTemporaryItemId: 1,
    nextDraftPackId: 1, nextDraftItemId: 1,
    tournament: { round: 0, rounds: [], matches: [], standings: [], completed_at: null, nextMatchId: 1, next_round_at: null },
    prizes: { awards: [], awarded_at: null }, cleanup: { temporary_items_removed_at: null },
    deadlines: {}, logs: [], nextLogId: 1, created_by: adminUserId == null ? null : Number(adminUserId),
    created_at: now.toISOString(), updated_at: now.toISOString(), completed_at: null, cancelled_at: null
  };
  appendWutDraftEventLog(event, 'event_created', { name: normalized.basic.name, preset_id: event.preset_id }, { actorUserId: adminUserId, now });
  return event;
}

export function transitionWutDraftEventRecord(event, nextPhase, { actorUserId = null, reason = '', now = new Date(), allowPrizeAwardTransition = false } = {}) {
  const target = choice(nextPhase, WUT_DRAFT_PHASES, '');
  if (!target) throw new Error('Unknown WUT Draft Event phase.');
  if (target === 'prizes_awarded' && !allowPrizeAwardTransition) throw new Error('Use the Draft Event prize award action to award prizes.');
  if (event.paused_at) throw new Error('Resume the event before changing phases.');
  const allowed = WUT_DRAFT_TRANSITIONS[event.phase] || [];
  if (!allowed.includes(target)) throw new Error(`Cannot move a draft event from ${event.phase} to ${target}.`);
  const previous = event.phase;
  event.phase = target;
  event.updated_at = now.toISOString();
  event.deadlines = {};
  if (target === 'cancelled') event.cancelled_at = now.toISOString();
  if (target === 'complete') event.completed_at = now.toISOString();
  appendWutDraftEventLog(event, target === 'cancelled' ? 'event_cancelled' : 'phase_changed', {
    from: previous, to: target, reason: text(reason, '', 500)
  }, { actorUserId, now });
  return event;
}

export function pauseWutDraftEventRecord(event, { actorUserId = null, reason = '', now = new Date() } = {}) {
  if (['prizes_awarded', 'cancelled'].includes(event.phase)) throw new Error('A finished draft event cannot be paused.');
  if (event.paused_at) throw new Error('This draft event is already paused.');
  event.paused_at = now.toISOString();
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'event_paused', { phase: event.phase, reason: text(reason, '', 500) }, { actorUserId, now });
  return event;
}

export function resumeWutDraftEventRecord(event, { actorUserId = null, now = new Date() } = {}) {
  if (!event.paused_at) throw new Error('This draft event is not paused.');
  const pausedForMs = Math.max(0, now.getTime() - new Date(event.paused_at).getTime());
  const shift = value => value ? new Date(new Date(value).getTime() + pausedForMs).toISOString() : value;
  event.deadlines = Object.fromEntries(Object.entries(event.deadlines || {}).map(([key, value]) => [key, shift(value)]));
  if (event.bench?.deadline_at) event.bench.deadline_at = shift(event.bench.deadline_at);
  if (event.draft?.deadline_at) event.draft.deadline_at = shift(event.draft.deadline_at);
  if (event.deckbuilding?.deadline_at) event.deckbuilding.deadline_at = shift(event.deckbuilding.deadline_at);
  if (event.tournament?.next_round_at) event.tournament.next_round_at = shift(event.tournament.next_round_at);
  for (const match of event.tournament?.matches || []) if (match.status === 'active' && match.turn_deadline) match.turn_deadline = shift(match.turn_deadline);
  const pausedAt = event.paused_at;
  event.paused_at = null;
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'event_resumed', { phase: event.phase, paused_at: pausedAt, shifted_ms: pausedForMs }, { actorUserId, now });
  return event;
}

export function cloneWutDraftPresetConfig() {
  return clone(NIGHTLY_WUT_DRAFT_PRESET.config);
}
