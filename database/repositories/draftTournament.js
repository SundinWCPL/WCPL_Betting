import { withTransaction } from '../postgres.js';
import {
  arenaCurrentPlayerId,
  arenaTurnCap,
  markWutCaptainPatchRole,
  maxWutLegalPlacements,
  nextArenaDeadline,
  nextWutActivePlayer,
  skipWutNoLegalPlayers,
  validateWutDeckSnapshots,
  WUT_CAPTAIN_PATCH_LIMIT,
  wutCaptainPatchCount,
  wutDeckRules
} from '../../services/arenaRuntime.js';
import {
  appendWutDraftEventLog,
  resolveWutDraftEventMatchRecord,
  selectWutDraftEliminationBye,
  transitionWutDraftEventRecord
} from '../../services/wutDraftEvents.js';
import { WUT_LAUNCH_TRINKET_EFFECTS, lockWardingChoices, normalizeWutTrinketEffect, trinketFitsWutPosition } from '../../services/wutBalanceRules.js';
import { getDraftEventPostgres, lockAndLoadDraftEvent, saveDraftEvent, saveDraftTournamentEvent } from './draftEventStore.js';
import { refundEntrant } from './draftEvents.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';
const clone = value => JSON.parse(JSON.stringify(value));
const asNumber = value => Number(value || 0);
const trinketEffectFor = (wutConfig, family, rarity) => clone(normalizeWutTrinketEffect(
  family,
  rarity,
  wutConfig?.trinketEffects?.[family]?.[rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[family]?.[rarity] ?? null
));

async function requireAdmin(client, userId) {
  const row = (await client.query('SELECT role FROM users WHERE id=$1', [Number(userId)])).rows[0];
  if (row?.role !== 'admin') throw new Error('Admin access is required for WUT Draft Event controls.');
}

const activeIds = event => {
  const active = new Set((event.entrants || []).filter(item => item.status === 'active').map(item => Number(item.user_id)));
  return (event.draft?.seat_user_ids || [...active]).map(Number).filter(id => active.has(id));
};

function stableTie(eventId, userId) {
  let hash = 2166136261;
  for (const char of `${eventId}|${userId}|standing`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

const resolved = match => ['ready', 'completed'].includes(match.status);

function standings(event) {
  const rows = new Map(activeIds(event).map(userId => [userId, { user_id: userId, played: 0, wins: 0, losses: 0,
    draws: 0, byes: 0, fp_for: 0, fp_against: 0, fp_differential: 0, opponent_wins: 0, rank: 0,
    tie: stableTie(event.id, userId) }]));
  for (const round of event.tournament.rounds || []) for (const userId of round.bye_user_ids || []) {
    const row = rows.get(Number(userId)); if (!row) continue;
    row.byes += 1;
    if (round.stage === 'round_robin' ? event.config.tournament.roundRobin.byeCountsAsWin : event.config.tournament.swiss.byeCountsAsWin) row.wins += 1;
  }
  for (const match of (event.tournament.matches || []).filter(resolved)) {
    const [a, b] = match.player_ids.map(Number); const first = rows.get(a); const second = rows.get(b);
    if (!first || !second) continue;
    const aScore = asNumber(match.scores?.[String(a)]); const bScore = asNumber(match.scores?.[String(b)]);
    first.played++; second.played++; first.fp_for += aScore; first.fp_against += bScore; second.fp_for += bScore; second.fp_against += aScore;
    if (match.winner_user_id == null) { first.draws++; second.draws++; }
    else if (Number(match.winner_user_id) === a) { first.wins++; second.losses++; }
    else { second.wins++; first.losses++; }
  }
  for (const row of rows.values()) row.fp_differential = row.fp_for - row.fp_against;
  for (const match of (event.tournament.matches || []).filter(resolved)) for (const userId of match.player_ids.map(Number)) {
    const opponent = match.player_ids.map(Number).find(id => id !== userId);
    rows.get(userId).opponent_wins += asNumber(rows.get(opponent)?.wins);
  }
  const ordered = [...rows.values()].sort((a, b) => b.wins - a.wins || b.draws - a.draws || b.opponent_wins - a.opponent_wins ||
    b.fp_differential - a.fp_differential || b.fp_for - a.fp_for || a.tie - b.tie);
  ordered.forEach((row, index) => { row.rank = index + 1; });
  event.tournament.standings = ordered;
  return ordered;
}

function deckSnapshot(event, userId) {
  const deck = event.decks[String(userId)];
  if (!deck) throw new Error(`Player ${userId} does not have a locked Event Deck.`);
  const convert = snapshot => {
    const player = snapshot.player || {};
    const season = player.cardType === 'mythic' ? player.sourceSeason : player.edition;
    return { card_id: Number(snapshot.event_item_id), card_identity: snapshot.card_identity, position: snapshot.position || player.position,
      rarity: snapshot.rarity || player.tier, team_id: player.teamId || '', team_name: player.teamDisplayName || player.teamName || player.teamId || '',
      season: season || '', chemistry_key: `${season || ''}|${player.teamId || ''}`, display_name: player.displayName || player.name || '',
      base_power: asNumber(snapshot.base_power || 1), power: asNumber(snapshot.power || snapshot.base_power || 1),
      trinket: snapshot.trinket ? clone(snapshot.trinket) : null };
  };
  return { active: (deck.active_snapshots || []).map(convert) };
}

function deadline(event, now) {
  if (!event.config.match.overnightPause) {
    return new Date(now.getTime() + Number(event.config.match.turnSeconds) * 1000).toISOString();
  }
  return nextArenaDeadline(now, { turnHours: Number(event.config.match.turnSeconds) / 3600,
    timeZone: event.environment_snapshot?.rules?.timeZone || 'America/Los_Angeles',
    pauseStartHour: 0, pauseEndHour: 8 }).toString();
}

function createMatch(event, playerIds, round, now, active = true, role = 'main') {
  const [first, second] = playerIds.map(Number);
  const id = Number(event.tournament.nextMatchId++);
  const match = { id, draft_event_id: Number(event.id), arena_match_key: `draft-${event.id}-${id}`,
    round: round.number, stage: round.stage, bracket_role: role, player_ids: [first, second],
    first_player_id: stableTie(`${event.id}|${round.number}`, first) < stableTie(`${event.id}|${round.number}`, second) ? first : second,
    turn_index: 0, turn_deadline: active ? deadline(event, now) : null, rules_version: 2,
    deck_snapshots: { [first]: deckSnapshot(event, first), [second]: deckSnapshot(event, second) }, placements: [],
    status: active ? 'active' : 'pending', scores: null, winner_user_id: null, revealed_by: [],
    boost_load_cap: Number(event.config.match.boostLoadCap), boosts_mode: event.config.match.boostsMode,
    rules_snapshot: clone(event.environment_snapshot?.rules || {}), created_at: now.toISOString(), resolved_at: null, completed_at: null };
  match.current_player_id = match.first_player_id;
  event.tournament.matches.push(match); round.match_ids.push(id); return match;
}

function startRound(event, plan, now) {
  const eligible = new Set(activeIds(event)); const pairs = []; const byes = [...(plan.byes || [])].filter(id => eligible.has(Number(id))); const roles = [];
  (plan.pairs || []).forEach((pair, index) => { const valid = pair.map(Number).filter(id => eligible.has(id));
    if (valid.length === 2) { pairs.push(valid); roles.push(plan.roles?.[index] || 'main'); } else if (valid.length === 1) byes.push(valid[0]); });
  const round = { number: Number(event.tournament.round || 0) + 1, stage: plan.stage, final_round: Boolean(plan.finalRound),
    status: 'active', match_ids: [], bye_user_ids: [...new Set(byes)], started_at: now.toISOString(), completed_at: null };
  event.tournament.round = round.number; event.tournament.rounds.push(round); event.tournament.next_round_at = null;
  pairs.forEach((pair, index) => createMatch(event, pair, round, now, event.config.match.simultaneousMatches || index === 0, roles[index]));
  appendWutDraftEventLog(event, 'tournament_round_started', { round: round.number, stage: round.stage, match_ids: round.match_ids, bye_user_ids: round.bye_user_ids }, { now });
  standings(event);
  if (!round.match_ids.length) advance(event, now);
  return round;
}

function roundRobin(ids, meetings) {
  const players = [...ids]; if (players.length % 2) players.push(null); const plans = [];
  for (let meeting = 0; meeting < meetings; meeting++) {
    const wheel = [...players];
    for (let round = 0; round < wheel.length - 1; round++) {
      const pairs = []; const byes = [];
      for (let index = 0; index < wheel.length / 2; index++) { const a = wheel[index]; const b = wheel[wheel.length - 1 - index];
        if (a == null || b == null) byes.push(Number(a ?? b)); else pairs.push(meeting % 2 ? [b, a] : [a, b]); }
      plans.push({ stage: 'round_robin', pairs, byes }); wheel.splice(1, 0, wheel.pop());
    }
  }
  return plans;
}

function elimination(event, ids) {
  const waiting = [...ids].map(Number); const byes = [];
  if (waiting.length % 2) { const previous = (event.tournament.rounds || []).flatMap(round => round.stage === 'elimination' ? round.bye_user_ids || [] : []);
    const bye = selectWutDraftEliminationBye(waiting, standings(event), previous); waiting.splice(waiting.indexOf(bye), 1); byes.push(bye); }
  const pairs = []; for (let index = 0; index < waiting.length / 2; index++) pairs.push([waiting[index], waiting[waiting.length - 1 - index]]);
  return { stage: 'elimination', pairs, byes, finalRound: ids.length <= 2, roles: pairs.map(() => ids.length <= 2 ? 'championship' : 'main') };
}

function swiss(event, ids) {
  const ordered = standings(event).filter(row => ids.includes(Number(row.user_id))).map(row => Number(row.user_id));
  const prior = new Set((event.tournament.matches || []).map(match => match.player_ids.map(Number).sort((a, b) => a - b).join(':')));
  const previousByes = new Set((event.tournament.rounds || []).flatMap(round => round.bye_user_ids || []).map(Number)); const byes = [];
  if (ordered.length % 2) { const bye = [...ordered].reverse().find(id => !previousByes.has(id)) ?? ordered.at(-1); ordered.splice(ordered.indexOf(bye), 1); byes.push(bye); }
  const pairs = [];
  while (ordered.length) { const first = ordered.shift(); let index = event.config.tournament.swiss.avoidRematches
    ? ordered.findIndex(second => !prior.has([first, second].sort((a, b) => a - b).join(':'))) : 0; if (index < 0) index = 0; pairs.push([first, ordered.splice(index, 1)[0]]); }
  return { stage: 'swiss', pairs, byes };
}

function initialize(event, now) {
  if (event.tournament.rounds.length || event.tournament.completed_at) return;
  event.tournament.nextMatchId ||= 1; const ids = activeIds(event);
  if (ids.length < 2) { event.tournament.completed_at = now.toISOString(); transitionWutDraftEventRecord(event, 'complete', { reason: 'Only one entrant remained', now }); return; }
  if (event.config.tournament.format === 'round_robin') { event.tournament.round_robin_plan = roundRobin(ids, event.config.tournament.roundRobin.meetings); startRound(event, event.tournament.round_robin_plan[0], now); }
  else if (event.config.tournament.format === 'single_elimination') startRound(event, elimination(event, ids), now);
  else startRound(event, swiss(event, ids), now);
}

function autoDeck(event, userId, now) {
  const inventory = event.inventories[String(userId)]; const rules = wutDeckRules(event.config.deckbuilding);
  const cards = [...inventory.cards].sort((a, b) => Number(a.power || 1) - Number(b.power || 1) || Number(a.id) - Number(b.id));
  const selectedCards = []; const identities = new Set(); let captainPatchCount = 0;
  const snapshot = card => { const trinket = inventory.trinkets.find(item => Number(item.id) === Number(card.trinket_id)); return {
    event_item_id: card.id, card_identity: card.card_identity, position: card.player_snapshot.position, rarity: card.rarity || card.player_snapshot.tier,
    base_power: Number(event.environment_snapshot.rules?.rarityCosts?.[card.rarity || card.player_snapshot.tier] || 1), power: Number(card.power || 1),
    player: clone(card.player_snapshot), trinket: trinket ? { id: trinket.id, family: trinket.family, rarity: trinket.rarity, effect: clone(trinket.effect || {}) } : null }; };
  const topLineupPower = selected => ['F', 'D', 'G'].reduce((sum, position) => {
    const needed = position === 'G' ? 1 : 2;
    return sum + selected.filter(card => card.player_snapshot.position === position)
      .map(card => Number(card.power || 1)).sort((a, b) => b - a).slice(0, needed)
      .reduce((part, power) => part + power, 0);
  }, 0);
  const canAdd = card => {
    const identity = String(card.card_identity || '');
    if (identities.has(identity)) return false;
    const trinket = inventory.trinkets.find(item => Number(item.id) === Number(card.trinket_id));
    return !(trinket?.family === 'team_crest' && captainPatchCount >= WUT_CAPTAIN_PATCH_LIMIT) &&
      topLineupPower([...selectedCards, card]) <= rules.topLineupMaxPower;
  };
  const add = card => {
    selectedCards.push(card); identities.add(String(card.card_identity || ''));
    const trinket = inventory.trinkets.find(item => Number(item.id) === Number(card.trinket_id));
    if (trinket?.family === 'team_crest') captainPatchCount += 1;
  };
  if (rules.requirePositions) {
    for (const [position, needed] of [['F', 2], ['D', 2], ['G', 1]]) {
      while (selectedCards.filter(card => card.player_snapshot.position === position).length < needed) {
        const next = cards.find(card => card.player_snapshot.position === position && !selectedCards.includes(card) && canAdd(card));
        if (!next) throw new Error(`Player ${userId} cannot build a legal Event Deck.`);
        add(next);
      }
    }
  }
  for (const card of cards) {
    if (selectedCards.length >= rules.deckSize) break;
    if (!selectedCards.includes(card) && canAdd(card)) add(card);
  }
  if (selectedCards.length < rules.deckSize) throw new Error(`Player ${userId} cannot build a legal Event Deck.`);
  const selected = selectedCards.map(card => Number(card.id));
  const activeSnapshots = selected.map(id => snapshot(inventory.cards.find(card => Number(card.id) === id)));
  validateWutDeckSnapshots(activeSnapshots, event.config.deckbuilding, 'Event Deck');
  event.decks[String(userId)] = { user_id: Number(userId), active_card_ids: selected, safety_bench_card_ids: [],
    active_snapshots: activeSnapshots,
    safety_bench_snapshots: [],
    submitted_at: now.toISOString(), automatic: true, locked: Boolean(event.config.deckbuilding.lockDeckForTournament) };
}

export async function finishWutDraftDeckbuildingWithClient(client, { eventId, adminUserId = null, autosubmitMissing = false, now = new Date() }) {
  if (adminUserId != null) await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'deckbuilding') throw new Error('Event deckbuilding is not active.');
  const ids = activeIds(event);
  if (autosubmitMissing) for (const id of ids) if (!event.decks[String(id)]) autoDeck(event, id, now);
  if (ids.some(id => !event.decks[String(id)])) { await saveDraftEvent(client, event); return event; }
  event.deckbuilding.completed_at = now.toISOString(); event.deckbuilding.deadline_at = null; delete event.deadlines.deckbuilding;
  transitionWutDraftEventRecord(event, 'tournament', { actorUserId: adminUserId, reason: 'All Event Decks submitted', now });
  initialize(event, now); appendWutDraftEventLog(event, 'deckbuilding_completed', { deck_count: ids.length, autosubmit_missing: autosubmitMissing }, { actorUserId: adminUserId, now });
  await saveDraftEvent(client, event); return event;
}

export async function commitWutDraftEventTurnWithClient(client, { eventId, matchId, userId, placements, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId); const match = event.tournament.matches.find(item => String(item.id) === String(matchId));
  if (!match || !(match.player_ids || []).map(Number).includes(Number(userId))) throw new Error('Draft Event match not found.');
  if (match.status !== 'active') throw new Error('This Draft Event match is not active.');
  const current = arenaCurrentPlayerId(match);
  if (current !== Number(userId)) throw new Error('It is not your turn.');
  const available = new Map([...(match.deck_snapshots[String(userId)]?.active || [])].map(card => [Number(card.card_id), card]));
  const required = maxWutLegalPlacements({
    cards: [...available.values()], placements: match.placements || [], userId,
    slotPowerAllowance: event.environment_snapshot.rules?.slotPowerAllowance || 1,
    trinketFits: trinketFitsWutPosition
  }, arenaTurnCap(match));
  if (required <= 0) {
    skipWutNoLegalPlayers(match, match.placements || [], {
      slotPowerAllowance: event.environment_snapshot.rules?.slotPowerAllowance || 1,
      trinketFits: trinketFitsWutPosition,
      cardsForUser: id => match.deck_snapshots[String(id)]?.active || []
    });
    match.turn_deadline = match.status === 'active' ? deadline(event, now) : null;
    await saveDraftTournamentEvent(client, event);
    return match;
  }
  if (!Array.isArray(placements) || placements.length !== required) throw new Error(`This turn requires ${required} legal cards.`);
  const existing = match.placements || []; const occupied = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => row.slot));
  const usedIds = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id)));
  const identities = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => row.card_snapshot?.card_identity)); const added = [];
  let captainCount = wutCaptainPatchCount(existing, userId);
  for (const input of placements) { const slot = String(input.slot || '').toUpperCase(); const card = available.get(Number(input.cardId));
    if (!['F1','F2','D1','D2','G'].includes(slot) || occupied.has(slot) || added.some(row => row.slot === slot)) throw new Error('Choose each open lineup slot only once.');
    if (!card || usedIds.has(Number(card.card_id)) || added.some(row => Number(row.card_id) === Number(card.card_id))) throw new Error('That card is unavailable.');
    if (identities.has(card.card_identity) || added.some(row => row.card_snapshot.card_identity === card.card_identity)) throw new Error('That player card is already in this lineup.');
    if (card.position !== (slot === 'G' ? 'G' : slot[0])) throw new Error(`That card is not eligible for ${slot}.`);
    if (!trinketFitsWutPosition(card.trinket?.family, card.position)) throw new Error('That trinket is not legal for this card position.');
    let cardSnapshot = card;
    if (card.trinket?.family === 'team_crest') {
      if (captainCount >= WUT_CAPTAIN_PATCH_LIMIT) throw new Error(`Only ${WUT_CAPTAIN_PATCH_LIMIT} Captain's Patches can be active in a lineup.`);
      cardSnapshot = markWutCaptainPatchRole(card, captainCount);
      captainCount += 1;
    }
    const opponent = existing.find(row => Number(row.user_id) !== Number(userId) && row.slot === slot);
    if (opponent && asNumber(cardSnapshot.power) > asNumber(opponent.power) + asNumber(event.environment_snapshot.rules?.slotPowerAllowance || 1)) throw new Error('That card exceeds the slot Power allowance.');
    let boost = null; if (input.boostId) { const inventory = event.inventories[String(userId)]; boost = inventory.boosts.find(item => Number(item.id) === Number(input.boostId));
      if (!boost || boost.consumed || existing.some(row => Number(row.boost_id) === Number(boost.id)) || added.some(row => Number(row.boost_id) === Number(boost.id))) throw new Error('That boost is unavailable.'); }
    added.push({ user_id: Number(userId), owner_user_id: Number(userId), slot, card_id: Number(card.card_id), boost_id: boost ? Number(boost.id) : null,
      boost_load: boost ? asNumber(event.environment_snapshot.rules?.rarityCosts?.[boost.rarity] || 1) : 0, power: asNumber(cardSnapshot.power),
      card_snapshot: clone(cardSnapshot), journeyman_key: String(input.journeymanKey || ''),
      ward_target_slot: String(input.wardTargetSlot || '').toUpperCase(), committed_at: now.toISOString() });
    if (boost && event.config.match.boostsMode !== 'refresh_each_match') { boost.consumed = true; boost.used_match_id = match.id; }
  }
  lockWardingChoices(match.placements || [], added);
  match.placements.push(...added); match.turn_index = Number(match.turn_index) + 1;
  match.exhausted_user_ids = (match.exhausted_user_ids || []).map(Number);
  const legalAfter = maxWutLegalPlacements({
    cards: [...available.values()], placements: match.placements || [], userId,
    slotPowerAllowance: event.environment_snapshot.rules?.slotPowerAllowance || 1,
    trinketFits: trinketFitsWutPosition
  }, arenaTurnCap(match));
  if (legalAfter <= 0 || match.placements.filter(row => Number(row.user_id) === Number(userId)).length >= 5) {
    match.exhausted_user_ids = [...new Set([...match.exhausted_user_ids, Number(userId)])];
  }
  const nextPlayer = nextWutActivePlayer(match, match.placements || [], {
    previousUserId: userId,
    slotPowerAllowance: event.environment_snapshot.rules?.slotPowerAllowance || 1,
    trinketFits: trinketFitsWutPosition,
    cardsForUser: id => match.deck_snapshots[String(id)]?.active || []
  });
  match.status = nextPlayer == null ? 'scoring' : 'active'; match.turn_deadline = match.status === 'active' ? deadline(event, now) : null; match.current_player_id = nextPlayer;
  await saveDraftTournamentEvent(client, event); return match;
}

export async function getDraftMatchesNeedingScoringPostgres(pool) {
  const events = await pool.query("SELECT id FROM draft_events WHERE phase='tournament'"); const matches = [];
  for (const row of events.rows) { const event = await getDraftEventPostgres(pool, row.id);
    for (const match of (event.tournament.matches || []).filter(item => item.status === 'scoring')) matches.push({ ...match, draft_event_id: event.id }); }
  return matches;
}

export async function skipWutDraftEventNoLegalTurnsWithClient(client, { eventId, matchId, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  const match = event.tournament.matches.find(item => String(item.id) === String(matchId));
  if (!match || match.status !== 'active') return match || null;
  const skipped = skipWutNoLegalPlayers(match, match.placements || [], {
    slotPowerAllowance: event.environment_snapshot.rules?.slotPowerAllowance || 1,
    trinketFits: trinketFitsWutPosition,
    cardsForUser: id => match.deck_snapshots[String(id)]?.active || []
  });
  if (!skipped.length) return match;
  match.turn_deadline = match.status === 'active' ? deadline(event, now) : null;
  await saveDraftTournamentEvent(client, event);
  return match;
}

export async function completeWutDraftEventMatchWithClient(client, { eventId, matchId, scoredPlacements, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId); const match = event.tournament.matches.find(item => String(item.id) === String(matchId));
  if (!match || match.status !== 'scoring') return match || null;
  match.placements = clone(scoredPlacements); const scores = Object.fromEntries(match.player_ids.map(id => [String(id),
    match.placements.filter(row => Number(row.user_id) === Number(id)).reduce((sum, row) => sum + asNumber(row.fp), 0)]));
  match.scores = scores; const [a, b] = match.player_ids.map(Number); match.winner_user_id = scores[a] === scores[b] ? null : scores[a] > scores[b] ? a : b;
  match.status = 'ready'; match.resolved_at = now.toISOString(); match.turn_deadline = null; standings(event);
  activateNext(event, now); advance(event, now);
  await saveDraftTournamentEvent(client, event); return match;
}

function activateNext(event, now) { if (event.config.match.simultaneousMatches) return; const round = event.tournament.rounds.at(-1);
  if (round.match_ids.some(id => event.tournament.matches.find(match => Number(match.id) === Number(id))?.status === 'active')) return;
  const next = round.match_ids.map(id => event.tournament.matches.find(match => Number(match.id) === Number(id))).find(match => match?.status === 'pending');
  if (next) { next.status = 'active'; next.turn_deadline = deadline(event, now); next.started_at = now.toISOString(); } }

function advance(event, now) {
  if (event.phase !== 'tournament') return;
  const round = event.tournament.rounds.at(-1); if (!round) return;
  if (round.status === 'completed') return;
  const matches = round.match_ids.map(id => event.tournament.matches.find(match => Number(match.id) === Number(id))).filter(Boolean);
  if (matches.some(match => !resolved(match) && !['voided','cancelled'].includes(match.status))) return;
  round.status = 'completed'; round.completed_at = now.toISOString(); standings(event); let plan = null; const format = event.config.tournament.format;
  if (format === 'round_robin') plan = event.tournament.round_robin_plan[round.number] || null;
  else if (format.startsWith('swiss') && round.stage === 'swiss' && round.number < Number(format === 'swiss' ? event.config.tournament.swiss.rounds : event.config.tournament.topCut.swissRounds)) plan = swiss(event, activeIds(event));
  else if (['single_elimination','swiss_top_cut'].includes(format) && round.stage === 'elimination' && !round.final_round) {
    const winners = [...round.bye_user_ids, ...matches.filter(resolved).map(match => Number(match.winner_user_id ?? match.player_ids[0]))]; if (winners.length > 1) plan = elimination(event, winners);
  } else if (format === 'swiss_top_cut' && round.stage === 'swiss') { const ids = standings(event).slice(0, event.config.tournament.topCut.advancing).map(row => row.user_id); plan = elimination(event, ids); }
  if (plan) startRound(event, plan, now); else { event.tournament.completed_at = now.toISOString(); transitionWutDraftEventRecord(event, 'complete', { reason: 'Tournament completed', now }); }
}

function resetMatch(event, match, active, now) {
  let releasedBoosts = 0;
  for (const row of match.placements || []) { if (!row.boost_id) continue; const inventory = event.inventories?.[String(row.owner_user_id || row.user_id)];
    const boost = inventory?.boosts?.find(item => Number(item.id) === Number(row.boost_id)); if (!boost || (boost.used_match_id && String(boost.used_match_id) !== String(match.arena_match_key))) continue;
    boost.consumed = false; delete boost.used_match_id; delete boost.used_slot; delete boost.consumed_at; releasedBoosts++; }
  const clearedPlacements = (match.placements || []).length; match.placements = []; match.status = active ? 'active' : 'pending'; match.turn_index = 0;
  match.current_player_id = active ? match.first_player_id : null; match.turn_deadline = active ? deadline(event, now) : null; match.scores = null; match.winner_user_id = null; match.forfeit_user_id = null; match.revealed_by = [];
  match.resolved_at = null; match.completed_at = null; if (active) match.started_at = now.toISOString(); else delete match.started_at;
  for (const key of ['forfeit_reason','elimination_tiebreak','cancel_reason','cancelled_at','void_reason','voided_at','voided_by']) delete match[key];
  return { clearedPlacements, releasedBoosts };
}

export async function completeWutDraftEventRevealWithClient(client, { eventId, matchId, userId, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId); const match = event.tournament.matches.find(item => String(item.id) === String(matchId));
  if (!match || !['ready','completed'].includes(match.status) || !match.player_ids.map(Number).includes(Number(userId))) throw new Error('Draft Event match is not ready to reveal.');
  match.revealed_by = [...new Set([...(match.revealed_by || []).map(Number), Number(userId)])];
  if (match.revealed_by.length >= match.player_ids.length) { match.status = 'completed'; match.completed_at = now.toISOString(); activateNext(event, now); advance(event, now); }
  await saveDraftTournamentEvent(client, event); return match;
}

export async function resolveWutDraftEventMatchWithClient(client, { eventId, matchId, action, forfeitingUserId = null, adminUserId, reason = '', now = new Date() }) {
  await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId); const match = event.tournament.matches.find(item => String(item.id) === String(matchId));
  if (!match) throw new Error('Draft Event match not found.');
  if (action === 'reset') { if (event.phase !== 'tournament' || !['pending','active','scoring'].includes(match.status)) throw new Error('Only an unresolved match in the active tournament can be reset.');
    const reset = resetMatch(event, match, true, now); appendWutDraftEventLog(event, 'match_reset', { match_id: match.id, reason: String(reason || '').trim().slice(0, 180) || 'Reset by administrator', ...reset }, { actorUserId: adminUserId, now });
    standings(event); await saveDraftEvent(client, event); return event; }
  resolveWutDraftEventMatchRecord(match, { action, forfeitingUserId, adminUserId, reason, now });
  standings(event); activateNext(event, now); advance(event, now); await saveDraftTournamentEvent(client, event); return event;
}

export async function timeoutWutDraftEventMatchWithClient(client, { eventId, matchId, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId); const match = event.tournament.matches.find(item => String(item.id) === String(matchId));
  if (!match || match.status !== 'active' || !match.turn_deadline || now < new Date(match.turn_deadline)) return event;
  const first = Number(match.first_player_id); const second = Number(match.player_ids.find(id => Number(id) !== first));
  const forfeitingUserId = Number(match.turn_index) % 2 === 0 ? first : second;
  resolveWutDraftEventMatchRecord(match, { action: 'forfeit', forfeitingUserId, adminUserId: null, reason: 'Turn timer expired', now });
  standings(event); activateNext(event, now); advance(event, now); await saveDraftTournamentEvent(client, event); return event;
}

export async function extendWutDraftDeckbuildingWithClient(client, { eventId, adminUserId, seconds, now = new Date() }) {
  await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'deckbuilding' || !event.deckbuilding.deadline_at) throw new Error('Event deckbuilding is not active.');
  const amount = Math.max(1, Math.min(604800, Math.round(Number(seconds) || 0)));
  event.deckbuilding.deadline_at = new Date(new Date(event.deckbuilding.deadline_at).getTime() + amount * 1000).toISOString();
  event.deadlines.deckbuilding = event.deckbuilding.deadline_at;
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'deckbuilding_timer_extended', { seconds: amount, deadline_at: event.deckbuilding.deadline_at }, { actorUserId: adminUserId, now });
  await saveDraftEvent(client, event);
  return event;
}

export async function updateWutDraftTournamentTurnSecondsWithClient(client, { eventId, adminUserId, seconds, now = new Date() }) {
  await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'tournament') throw new Error('Tournament turn timers can only be changed during the tournament phase.');
  const amount = Math.max(15, Math.min(604800, Math.round(Number(seconds) || 0)));
  event.config.match.turnSeconds = amount;
  const base = event.paused_at ? new Date(event.paused_at) : now;
  const activeMatchIds = [];
  for (const match of event.tournament.matches || []) {
    if (match.status !== 'active') continue;
    match.turn_deadline = deadline(event, base);
    activeMatchIds.push(Number(match.id));
  }
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'tournament_turn_timer_updated', {
    seconds: amount,
    active_match_ids: activeMatchIds
  }, { actorUserId: adminUserId, now });
  await saveDraftTournamentEvent(client, event);
  return event;
}

export async function advanceWutDraftEventRoundWithClient(client, { eventId, adminUserId, now = new Date() }) {
  await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId); const before = event.tournament.round;
  advance(event, now);
  if (event.phase === 'tournament' && Number(event.tournament.round) === Number(before)) throw new Error('Resolve every match in the current round before advancing.');
  await saveDraftTournamentEvent(client, event); return event;
}

export async function dropWutDraftEventEntrantWithClient(client, { eventId, userId, adminUserId, reason = '', now = new Date() }) {
  await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId);
  const entrant = event.entrants.find(item => Number(item.user_id) === Number(userId) && item.status === 'active');
  if (!entrant) throw new Error('That player is not an active entrant.');
  entrant.status = 'dropped'; entrant.dropped_at = now.toISOString(); entrant.drop_reason = String(reason || 'Dropped by an administrator.').trim().slice(0, 180);
  const refunded = ['scheduled','signup_open','signup_closed'].includes(event.phase) ? await refundEntrant(client, event, entrant, entrant.drop_reason, now) : 0;
  appendWutDraftEventLog(event, 'player_dropped', { user_id: Number(userId), reason: entrant.drop_reason, refunded }, { actorUserId: adminUserId, now });
  for (const match of (event.tournament?.matches || []).filter(item => ['pending','active','scoring'].includes(item.status) && item.player_ids.map(Number).includes(Number(userId)))) {
    resolveWutDraftEventMatchRecord(match, { action: 'forfeit', forfeitingUserId: userId, adminUserId, reason: entrant.drop_reason, now });
  }
  standings(event); activateNext(event, now); advance(event, now); await saveDraftEvent(client, event); return event;
}

export async function resetCurrentWutDraftEventRoundWithClient(client, { eventId, adminUserId, reason = '', now = new Date() }) {
  await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'tournament') throw new Error('Only an active tournament round can be reset.'); const round = event.tournament.rounds.at(-1);
  if (!round?.match_ids?.length) throw new Error('There is no tournament round to reset.'); const matches = round.match_ids.map(id => event.tournament.matches.find(match => Number(match.id) === Number(id))).filter(Boolean);
  const simultaneous = Boolean(event.config.match.simultaneousMatches); let clearedPlacements = 0; let releasedBoosts = 0;
  matches.forEach((match, index) => { const reset = resetMatch(event, match, simultaneous || index === 0, now); clearedPlacements += reset.clearedPlacements; releasedBoosts += reset.releasedBoosts; });
  round.status = 'active'; round.completed_at = null; event.tournament.next_round_at = null; delete event.tournament.pending_round_plan; event.tournament.completed_at = null; event.completed_at = null; standings(event);
  appendWutDraftEventLog(event, 'tournament_round_reset', { round: round.number, match_ids: matches.map(match => match.id), cleared_placements: clearedPlacements, released_boosts: releasedBoosts,
    reason: String(reason || '').trim().slice(0, 180) || 'Current round reset by administrator' }, { actorUserId: adminUserId, now });
  await saveDraftEvent(client, event); return event;
}

export async function awardWutDraftEventPrizesWithClient(client, { eventId, adminUserId, generatePack, random = Math.random, now = new Date() }) {
  if (adminUserId != null) await requireAdmin(client, adminUserId); const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.prizes?.awarded_at) return { event, alreadyAwarded: true, awards: event.prizes.awards || [] };
  const strandedPrizePhase = event.phase === 'prizes_awarded' && !(event.prizes?.awards || []).length;
  if (!['complete', 'prizes_awarded'].includes(event.phase) || (!strandedPrizePhase && event.phase !== 'complete') || !event.tournament.completed_at) throw new Error('Draft Event prizes can only be awarded after the tournament is complete.');
  const active = new Set(activeIds(event)); const rows = standings(event).filter(row => active.has(Number(row.user_id))); const awards = [];
  const cardsMeta = (await client.query("SELECT data FROM app_documents WHERE document_key='cards_meta'")).rows[0]?.data || {};
  const settings = (await client.query("SELECT data FROM app_documents WHERE document_key='settings'")).rows[0]?.data || {};
  const families = Object.keys(WUT_LAUNCH_TRINKET_EFFECTS); const rarities = ['common','uncommon','rare','epic','legendary'];
  const randomRarity = () => { const odds = cardsMeta.config?.playerTierOdds?.standard || { common:55,uncommon:25,rare:13,epic:6,legendary:1 }; const total = rarities.reduce((sum, rarity) => sum + Number(odds[rarity] || 0), 0) || 1; let roll = random() * total;
    return rarities.find(rarity => (roll -= Number(odds[rarity] || 0)) < 0) || 'common'; };
  for (const row of rows) for (const tier of event.config.prizes.tiers || []) {
    if (!tier.participant && !(tier.places || []).map(Number).includes(Number(row.rank))) continue;
    for (const reward of tier.rewards || []) for (let copy = 0; copy < Number(reward.quantity || 1); copy++) {
      const base = { id: awards.length + 1, user_id: Number(row.user_id), rank: Number(row.rank), tier_key: tier.key, tier_label: tier.label, awarded_at: now.toISOString() };
      if (reward.type === 'wut_coins') { const membership = await lockWutMembership(client, row.user_id, { requireStarter: false }); await changeWutCoins(client, membership, Number(reward.amount || 0), 'draft_event_prize', { draft_event_id: Number(event.id), placement: Number(row.rank) }, now);
        awards.push({ ...base, type: 'wut_coins', amount: Number(reward.amount || 0) }); continue; }
      if (reward.type === 'player_pack') { const items = generatePack?.(reward.packType, { userId: row.user_id, rank: row.rank, tierKey: tier.key, copy });
        if (!Array.isArray(items) || items.length !== 5 || items.filter(item => item.itemType === 'player').length !== 3 || items.filter(item => item.itemType === 'boost').length !== 2) throw new Error('Generated Draft Event prize packs must contain three players and two boosts.');
        const id = Number((await client.query("SELECT nextval('pack_purchases_id_seq') AS id")).rows[0].id); const pending = Boolean((await client.query("SELECT 1 FROM pack_purchases WHERE user_id=$1 AND status='pending' LIMIT 1", [row.user_id])).rows[0]); const status = pending ? 'queued' : 'pending';
        const purchase = { id, user_id: Number(row.user_id), week: Number(settings.currentWeek || 1), pack_kind: 'player', pack_type: reward.packType, price: 0, list_price: 0, free_purchase: true, source: 'draft_event_prize', draft_event_id: Number(event.id), placement: Number(row.rank), items, status, created_at: now.toISOString(), claimed_at: null };
        await client.query(`INSERT INTO pack_purchases(id,user_id,status,pack_kind,pack_type,created_at,source_order,data) VALUES($1,$2,$3,'player',$4,$5,$6,$7::jsonb)`, [id,row.user_id,status,reward.packType,purchase.created_at,id,JSON.stringify(purchase)]);
        awards.push({ ...base, type: 'player_pack', pack_type: reward.packType, pack_purchase_id: id, status }); continue; }
      const rarity = reward.rarity === 'any' ? randomRarity() : String(reward.rarity || 'common'); const family = reward.type === 'specific_trinket' ? reward.family : families[Math.floor(random() * families.length)];
      const id = Number((await client.query("SELECT nextval('owned_trinkets_id_seq') AS id")).rows[0].id); const trinket = { id, user_id: Number(row.user_id), family, rarity, effect: trinketEffectFor(cardsMeta.config?.wut || {}, family, rarity), attached_card_id: null, source: 'draft_event_prize', draft_event_id: Number(event.id), created_at: now.toISOString() };
      await client.query(`INSERT INTO owned_trinkets(id,user_id,family,rarity,attached_card_id,source_order,data) VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb)`, [id,row.user_id,family,rarity,id,JSON.stringify(trinket)]); awards.push({ ...base, type:'trinket', family, rarity, trinket_id:id });
    }
  }
  event.prizes.awards = awards; event.prizes.awarded_at = now.toISOString();
  event.archived_inventories = Object.keys(event.archived_inventories || {}).length ? event.archived_inventories : event.inventories;
  event.archived_decks = Object.keys(event.archived_decks || {}).length ? event.archived_decks : event.decks;
  event.inventories = {}; event.decks = {};
  event.cleanup.temporary_items_removed_at = now.toISOString();
  if (event.phase === 'complete') transitionWutDraftEventRecord(event, 'prizes_awarded', { actorUserId: adminUserId, reason: 'Prizes awarded and temporary Event Collections retired', now, allowPrizeAwardTransition: true });
  else event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'prizes_awarded', { award_count: awards.length, recipients: [...new Set(awards.map(item => item.user_id))] }, { actorUserId: adminUserId, now }); await saveDraftEvent(client, event);
  return { event, alreadyAwarded: false, awards };
}

export const finishWutDraftDeckbuildingPostgres = (pool, input) => withTransaction(pool, client => finishWutDraftDeckbuildingWithClient(client, input));
export const commitWutDraftEventTurnPostgres = (pool, input) => withTransaction(pool, client => commitWutDraftEventTurnWithClient(client, input));
export const skipWutDraftEventNoLegalTurnsPostgres = (pool, input) => withTransaction(pool, client => skipWutDraftEventNoLegalTurnsWithClient(client, input));
export const completeWutDraftEventMatchPostgres = (pool, input) => withTransaction(pool, client => completeWutDraftEventMatchWithClient(client, input));
export const completeWutDraftEventRevealPostgres = (pool, input) => withTransaction(pool, client => completeWutDraftEventRevealWithClient(client, input));
export const resolveWutDraftEventMatchPostgres = (pool, input) => withTransaction(pool, client => resolveWutDraftEventMatchWithClient(client, input));
export const timeoutWutDraftEventMatchPostgres = (pool, input) => withTransaction(pool, client => timeoutWutDraftEventMatchWithClient(client, input));
export const extendWutDraftDeckbuildingPostgres = (pool, input) => withTransaction(pool, client => extendWutDraftDeckbuildingWithClient(client, input));
export const updateWutDraftTournamentTurnSecondsPostgres = (pool, input) => withTransaction(pool, client => updateWutDraftTournamentTurnSecondsWithClient(client, input));
export const advanceWutDraftEventRoundPostgres = (pool, input) => withTransaction(pool, client => advanceWutDraftEventRoundWithClient(client, input));
export const dropWutDraftEventEntrantPostgres = (pool, input) => withTransaction(pool, client => dropWutDraftEventEntrantWithClient(client, input));
export const resetCurrentWutDraftEventRoundPostgres = (pool, input) => withTransaction(pool, client => resetCurrentWutDraftEventRoundWithClient(client, input));
export const awardWutDraftEventPrizesPostgres = (pool, input) => withTransaction(pool, client => awardWutDraftEventPrizesWithClient(client, input));
