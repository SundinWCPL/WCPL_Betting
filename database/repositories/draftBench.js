import { withTransaction } from '../postgres.js';
import {
  appendWutDraftEventLog,
  resolveWutDraftBenchWinners,
  selectWutDraftBenchPool,
  transitionWutDraftEventRecord
} from '../../services/wutDraftEvents.js';
import { beginWutDraftEventWithClient } from './draftGameplay.js';
import { lockAndLoadDraftEvent, saveDraftEvent } from './draftEventStore.js';

const clone = value => JSON.parse(JSON.stringify(value));

async function requireAdmin(client, userId) {
  const row = (await client.query('SELECT role FROM users WHERE id=$1', [Number(userId)])).rows[0];
  if (row?.role !== 'admin') throw new Error('Admin access is required for WUT Draft Event controls.');
}

function ensureInventories(event) {
  for (const entrant of (event.entrants || []).filter(item => item.status === 'active')) {
    const key = String(entrant.user_id);
    event.inventories[key] = { cards: [], boosts: [], trinkets: [], safety_bench_card_ids: [], ...(event.inventories[key] || {}) };
  }
}

function temporaryBenchCard(event, winner, now) {
  const card = winner.card;
  return {
    id: Number(event.nextTemporaryItemId++), item_type: 'player', source: 'shared_safety_bench',
    card_identity: card.cardIdentity, player_snapshot: clone(card),
    power: Number(event.environment_snapshot?.rules?.rarityCosts?.[card.tier] || 1), created_at: now.toISOString()
  };
}

async function finalizeBench(client, event, { adminUserId = null, now, random, winners = null, reason = '' }) {
  if (event.bench.completed_at) return event;
  if (event.phase !== 'bench_vote') throw new Error('The shared Safety Bench is not active.');
  const resolved = winners || resolveWutDraftBenchWinners(event.config, event.bench.candidates, event.bench.votes, random);
  event.bench.winners = clone(resolved);
  event.bench.completed_at = now.toISOString();
  event.bench.deadline_at = null;
  delete event.deadlines.bench_vote;
  ensureInventories(event);
  for (const entrant of (event.entrants || []).filter(item => item.status === 'active')) {
    const inventory = event.inventories[String(entrant.user_id)];
    const copies = resolved.map(winner => temporaryBenchCard(event, winner, now));
    inventory.cards.push(...copies);
    inventory.safety_bench_card_ids = copies.map(card => card.id);
  }
  appendWutDraftEventLog(event, 'bench_selected', {
    winners: resolved.map(winner => ({ card_identity: winner.card.cardIdentity, position: winner.position, votes: winner.votes || 0 })),
    voter_count: event.bench.votes.length, reason
  }, { actorUserId: adminUserId, now });
  transitionWutDraftEventRecord(event, 'draft', { actorUserId: adminUserId, reason: 'Shared Safety Bench completed', now });
  await saveDraftEvent(client, event);
  return beginWutDraftEventWithClient(client, { eventId: event.id, adminUserId, now, random, system: adminUserId == null });
}

export async function beginWutDraftSafetyBenchWithClient(client, {
  eventId, adminUserId, system = false, benchCards = null, now = new Date(), random = Math.random
}) {
  if (!system) await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('Resume the event before beginning the Safety Bench.');
  if (event.phase !== 'starting') throw new Error('The Safety Bench can only begin while the event is starting.');
  if (!event.environment_snapshot?.cards) throw new Error('Freeze the event environment before creating the Safety Bench.');
  ensureInventories(event);
  if (Array.isArray(benchCards) && benchCards.length) event.environment_snapshot.bench_cards = clone(benchCards);
  const source = event.environment_snapshot.bench_cards?.length ? event.environment_snapshot.bench_cards : event.environment_snapshot.cards;
  const mode = event.config.safetyBench.mode;
  if (mode === 'disabled') {
    transitionWutDraftEventRecord(event, 'draft', { actorUserId: adminUserId, reason: 'Safety Bench disabled', now });
    await saveDraftEvent(client, event);
    return beginWutDraftEventWithClient(client, { eventId, adminUserId, now, random, system });
  }
  let candidates;
  if (mode === 'preset_shared') {
    const identities = new Set(event.config.safetyBench.presetCards.map(String));
    candidates = source.filter(card => identities.has(String(card.cardIdentity))).map(card => ({ position: card.position, card: clone(card) }));
    for (const position of ['F', 'D', 'G']) {
      const needed = event.config.safetyBench.positions[position].winners;
      if (candidates.filter(candidate => candidate.position === position).length < needed) throw new Error(`Preset Safety Bench needs ${needed} eligible ${position} cards.`);
    }
  } else candidates = selectWutDraftBenchPool(event.config, source, random);
  event.bench = { candidates, votes: [], winners: [], deadline_at: null, completed_at: null, started_at: now.toISOString() };
  transitionWutDraftEventRecord(event, 'bench_vote', { actorUserId: adminUserId, reason: `${mode} Safety Bench`, now });
  appendWutDraftEventLog(event, 'bench_candidates_generated', { mode, candidates: candidates.map(candidate => candidate.card.cardIdentity) }, { actorUserId: adminUserId, now });
  if (mode === 'shared_vote') {
    event.bench.deadline_at = new Date(now.getTime() + Number(event.config.safetyBench.votingSeconds) * 1000).toISOString();
    event.deadlines.bench_vote = event.bench.deadline_at;
    await saveDraftEvent(client, event);
    return event;
  }
  const winners = mode === 'preset_shared'
    ? ['F', 'D', 'G'].flatMap(position => candidates.filter(candidate => candidate.position === position)
      .slice(0, event.config.safetyBench.positions[position].winners).map(candidate => ({ ...candidate, votes: 0 })))
    : null;
  return finalizeBench(client, event, { adminUserId, now, random, winners, reason: mode });
}

export async function voteWutDraftSafetyBenchWithClient(client, { eventId, userId, selections, now = new Date() }) {
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.paused_at) throw new Error('This Draft Event is paused.');
  if (event.phase !== 'bench_vote' || event.config.safetyBench.mode !== 'shared_vote' || event.bench.completed_at) throw new Error('Safety Bench voting is not open.');
  if (event.bench.deadline_at && now >= new Date(event.bench.deadline_at)) throw new Error('Safety Bench voting has closed.');
  if (!(event.entrants || []).some(item => Number(item.user_id) === Number(userId) && item.status === 'active')) throw new Error('Only active entrants can vote.');
  const clean = {};
  for (const position of ['F', 'D', 'G']) {
    const allowed = new Set(event.bench.candidates.filter(candidate => candidate.position === position).map(candidate => candidate.card.cardIdentity));
    const requested = [...new Set((selections?.[position] || []).map(String))];
    const needed = event.config.safetyBench.positions[position].winners;
    if (requested.length !== needed || requested.some(identity => !allowed.has(identity))) throw new Error(`Choose exactly ${needed} eligible ${position} cards.`);
    clean[position] = requested;
  }
  let vote = event.bench.votes.find(item => Number(item.user_id) === Number(userId));
  if (!vote) { vote = { user_id: Number(userId), created_at: now.toISOString() }; event.bench.votes.push(vote); }
  vote.selections = clean; vote.updated_at = now.toISOString();
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'bench_vote_cast', { user_id: Number(userId) }, { actorUserId: userId, now });
  await saveDraftEvent(client, event);
  return event;
}

export async function finishWutDraftSafetyBenchWithClient(client, { eventId, adminUserId = null, system = false, reason = 'Finished by administrator', now = new Date(), random = Math.random }) {
  if (!system) await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  return finalizeBench(client, event, { adminUserId, now, random, reason });
}

export async function extendWutDraftSafetyBenchWithClient(client, { eventId, adminUserId, seconds, now = new Date() }) {
  await requireAdmin(client, adminUserId);
  const event = await lockAndLoadDraftEvent(client, eventId);
  if (event.phase !== 'bench_vote' || !event.bench.deadline_at) throw new Error('Safety Bench voting is not active.');
  const amount = Math.max(1, Math.min(86400, Math.round(Number(seconds) || 0)));
  event.bench.deadline_at = new Date(new Date(event.bench.deadline_at).getTime() + amount * 1000).toISOString();
  event.deadlines.bench_vote = event.bench.deadline_at;
  event.updated_at = now.toISOString();
  appendWutDraftEventLog(event, 'bench_timer_extended', { seconds: amount, deadline_at: event.bench.deadline_at }, { actorUserId: adminUserId, now });
  await saveDraftEvent(client, event);
  return event;
}

export const beginWutDraftSafetyBenchPostgres = (pool, input) => withTransaction(pool, client => beginWutDraftSafetyBenchWithClient(client, input));
export const voteWutDraftSafetyBenchPostgres = (pool, input) => withTransaction(pool, client => voteWutDraftSafetyBenchWithClient(client, input));
export const finishWutDraftSafetyBenchPostgres = (pool, input) => withTransaction(pool, client => finishWutDraftSafetyBenchWithClient(client, input));
export const extendWutDraftSafetyBenchPostgres = (pool, input) => withTransaction(pool, client => extendWutDraftSafetyBenchWithClient(client, input));
