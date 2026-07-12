import { withTransaction } from '../postgres.js';
import {
  ARENA_DEFAULT_ELO,
  arenaRecentOpponentPairs,
  buildArenaDraftPacks,
  nextArenaDeadline,
  normalizeArenaDraftConfig,
  pairArenaEntries,
  validateWutDeckSnapshots
} from '../../services/arenaRuntime.js';
import { isPlayerPackEligible } from '../../services/cards.js';
import { zonedDateKey } from '../../services/zonedTime.js';
import { WUT_LAUNCH_TRINKET_EFFECTS, normalizeWutTrinketEffect } from '../../services/wutBalanceRules.js';

const asNumber = value => Number(value || 0);
const MATCHMAKING_MINUTES = 30;
const clone = value => JSON.parse(JSON.stringify(value));
const arenaModeOf = value => String(value || 'constructed') === 'draft' ? 'draft' : 'constructed';
const trinketEffectFor = (wutConfig, family, rarity) => clone(normalizeWutTrinketEffect(
  family,
  rarity,
  wutConfig?.trinketEffects?.[family]?.[rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[family]?.[rarity] ?? null
));

async function lockArenaMeta(client) {
  const result = await client.query("SELECT data FROM app_documents WHERE document_key='arena_meta' FOR UPDATE");
  if (!result.rows[0]) throw new Error('Required PostgreSQL document is missing: arena_meta.');
  return result.rows[0].data || {};
}

async function saveArenaMeta(client, meta) {
  await client.query("UPDATE app_documents SET data=$2::jsonb,updated_at=now() WHERE document_key=$1", ['arena_meta', JSON.stringify(meta)]);
}

export async function assignArenaMatchupsWithClient(client, { now = new Date(), random = Math.random, catalog = [] } = {}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242060]);
  const meta = await lockArenaMeta(client);
  const config = meta.config || {};
  const queued = (await client.query("SELECT id,user_id,data FROM arena_entries WHERE status='queued' ORDER BY joined_at,id FOR UPDATE")).rows;
  const active = (await client.query("SELECT data,status FROM arena_matches WHERE status IN ('drafting','choosing_first','active','scoring','ready')")).rows.map(row => row.data || {});
  for (const row of queued) {
    const activeCount = active.filter(match => arenaModeOf(match.mode) === arenaModeOf(row.data?.mode) &&
      (match.player_ids || []).map(Number).includes(Number(row.user_id))).length;
    if (activeCount < asNumber(config.maxActiveMatches || 3)) continue;
    const entry = { ...(row.data || {}), status: 'cancelled', cancel_reason: 'active_match_cap', cancelled_at: now.toISOString() };
    await client.query("UPDATE arena_entries SET status='cancelled',data=$2::jsonb WHERE id=$1", [row.id, JSON.stringify(entry)]);
    row.data = entry;
  }
  const eligible = queued.filter(row => row.data?.status === 'queued' && ((row.data?.mode || 'constructed') === 'draft' || row.data?.deck_snapshot) &&
    active.filter(match => arenaModeOf(match.mode) === arenaModeOf(row.data?.mode) && (match.player_ids || []).map(Number).includes(Number(row.user_id))).length < asNumber(config.maxActiveMatches || 3)
  ).map(row => ({ ...row.data, id: asNumber(row.id), user_id: asNumber(row.user_id) }));
  const ratings = new Map((await client.query('SELECT user_id,rating FROM arena_ratings')).rows.map(row => [asNumber(row.user_id), Number(row.rating)]));
  const history = (await client.query("SELECT data,status FROM arena_matches WHERE match_kind='arena' AND status NOT IN ('cancelled','voided')")).rows;
  const activePairs = new Set(history.filter(row => ['drafting','choosing_first','active','scoring','ready'].includes(row.status)).map(row =>
    (row.data?.player_ids || []).map(Number).sort((a, b) => a - b).join(':')
  ));
  const recentPairs = arenaRecentOpponentPairs(history.filter(row => ['ready','completed'].includes(row.status)).map(row => row.data || {}), config.recentOpponentMatchCount ?? 2);
  const avoidPairs = new Set([...activePairs, ...recentPairs]);
  const created = [];
  const unmatchedEntries = [];
  for (const mode of ['draft', 'constructed']) {
    const { pairs, unmatched } = pairArenaEntries(
      eligible.filter(entry => (entry.mode || 'constructed') === mode),
      entry => ratings.get(Number(entry.user_id)) ?? ARENA_DEFAULT_ELO,
      (a, b) => avoidPairs.has([Number(a.user_id), Number(b.user_id)].sort((x, y) => x - y).join(':'))
    );
    for (const [first, second] of pairs) {
    for (const entry of [first, second]) {
      entry.status = 'matched';
      entry.priority = false;
      entry.matched_at = now.toISOString();
      await client.query("UPDATE arena_entries SET status='matched',data=$2::jsonb WHERE id=$1", [entry.id, JSON.stringify(entry)]);
    }
    const id = asNumber((await client.query("SELECT nextval('arena_matches_numeric_id_seq') AS id")).rows[0].id);
    const firstPlayer = random() < 0.5 ? first.user_id : second.user_id;
    const match = {
      id,
      mode,
      player_ids: [Number(first.user_id), Number(second.user_id)],
      entry_ids: [first.id, second.id],
      first_player_id: Number(firstPlayer),
      current_player_id: mode === 'draft' ? null : Number(firstPlayer),
      turn_index: 0,
      turn_deadline: nextArenaDeadline(now, config),
      rules_version: 2,
      deck_snapshots: mode === 'draft' ? {} : {
        [String(first.user_id)]: JSON.parse(JSON.stringify(first.deck_snapshot)),
        [String(second.user_id)]: JSON.parse(JSON.stringify(second.deck_snapshot))
      },
      entry_fee: 0,
      prize_amount: 60,
      starting_elo: {
        [String(first.user_id)]: ratings.get(Number(first.user_id)) ?? ARENA_DEFAULT_ELO,
        [String(second.user_id)]: ratings.get(Number(second.user_id)) ?? ARENA_DEFAULT_ELO
      },
      placements: [], status: mode === 'draft' ? 'drafting' : 'active', scores: null, winner_user_id: null,
      winnings_claimed_at: null, created_at: now.toISOString(), resolved_at: null, completed_at: null
    };
    if (mode === 'draft') {
      const cardsMeta = (await client.query("SELECT data FROM app_documents WHERE document_key='cards_meta'")).rows[0]?.data || {};
      const wutConfig = cardsMeta.config?.wut || {};
      const boostEffects = cardsMeta.config?.boostEffects || {};
      const families = Object.keys(wutConfig.trinketEffects || WUT_LAUNCH_TRINKET_EFFECTS);
      match.mini_draft = { packs: buildArenaDraftPacks({
        catalog: (catalog || []).filter(isPlayerPackEligible), config, wutConfig,
        trinketFamilies: families, boostTypes: ['goal','assist','shot','grit','save','shutout'],
        trinketEffect: (family, rarity) => trinketEffectFor(wutConfig, family, rarity),
        boostEffect: (type, rarity) => clone(boostEffects?.[type]?.[rarity] || null),
        random
      }), pack_count: normalizeArenaDraftConfig(config).packCount };
      match.draft_loadouts = {};
    } else {
      match.series_format = 'bo3';
      match.series_target_wins = 2;
      match.series_max_games = 3;
      match.series_game_number = 1;
      match.series_games = [];
      match.series_wins = Object.fromEntries(match.player_ids.map(id => [String(id), 0]));
      match.series_total_fp = Object.fromEntries(match.player_ids.map(id => [String(id), 0]));
      match.coin_flip_winner_user_id = Number(firstPlayer);
      match.first_player_decider_user_id = Number(firstPlayer);
      match.first_player_decider_reason = 'coin_flip';
      match.first_player_id = null;
      match.current_player_id = null;
      match.status = 'choosing_first';
    }
    await client.query(`
      INSERT INTO arena_matches(match_key,numeric_id,match_kind,status,current_player_id,turn_deadline,created_at,source_order,data)
      VALUES($1,$2,'arena',$3,$4,$5,$6,$7,$8::jsonb)
    `, [String(id), id, match.status, match.current_player_id, match.turn_deadline, match.created_at, id, JSON.stringify({ ...match, placements: undefined })]);
    created.push(id);
  }
    if (unmatched) unmatchedEntries.push(unmatched);
  }
  for (const unmatched of unmatchedEntries) {
    unmatched.priority = true;
    unmatched.carried_at = now.toISOString();
    await client.query('UPDATE arena_entries SET data=$2::jsonb WHERE id=$1', [unmatched.id, JSON.stringify(unmatched)]);
  }
  meta.lastMatchmakingSlot = String(Math.floor(now.getTime() / (MATCHMAKING_MINUTES * 60000)));
  meta.lastMatchmakingAt = now.toISOString();
  await saveArenaMeta(client, meta);
  return { createdMatchIds: created, unmatchedUserId: unmatchedEntries[0]?.user_id || null, lastMatchmakingAt: now.toISOString() };
}

export async function enterArenaQueueWithClient(client, {
  userId, mode = 'draft', deckId, deckSnapshot, now = new Date(), random = Math.random, catalog = []
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242060]);
  const meta = await lockArenaMeta(client);
  const config = meta.config || {};
  const cleanMode = mode === 'constructed' ? 'constructed' : 'draft';
  const activeCount = asNumber((await client.query(`
    SELECT count(*)::integer AS count FROM arena_matches
    WHERE status IN ('drafting','choosing_first','active','scoring','ready') AND data->'player_ids' @> $1::jsonb
      AND COALESCE(data->>'mode','constructed')=$2
  `, [JSON.stringify([Number(userId)]), cleanMode])).rows[0].count);
  if (activeCount >= asNumber(config.maxActiveMatches || 3)) throw new Error(`You already have ${config.maxActiveMatches} active ${cleanMode === 'draft' ? 'Draft Arena' : 'Constructed Arena'} matches.`);
  const existingEntry = (await client.query(
    "SELECT 1 FROM arena_entries WHERE user_id=$1 AND status='queued' AND COALESCE(data->>'mode','constructed')=$2 LIMIT 1",
    [Number(userId), cleanMode]
  )).rows[0];
  if (existingEntry) throw new Error(`You are already in the ${cleanMode === 'draft' ? 'Draft Arena' : 'Constructed Arena'} queue.`);
  let deck = { rows: [] };
  if (cleanMode === 'constructed') {
    deck = await client.query('SELECT id,name,data FROM wut_decks WHERE id=$1 AND user_id=$2', [Number(deckId), Number(userId)]);
    if (!deck.rows[0]) throw new Error('Select a saved deck before entering the Constructed Arena queue.');
    if (!deckSnapshot || !Array.isArray(deckSnapshot.active)) throw new Error('That deck is not queue-ready.');
    const cardsMeta = (await client.query("SELECT data FROM app_documents WHERE document_key='cards_meta'")).rows[0]?.data || {};
    validateWutDeckSnapshots(deckSnapshot.active, cardsMeta.config?.wut || {}, 'Deck');
    const savedDeck = deck.rows[0].data || {};
    const sameIds = (saved, snapshot) => {
      const left = (saved || []).map(Number).sort((a, b) => a - b);
      const right = (snapshot || []).map(card => Number(card.card_id)).sort((a, b) => a - b);
      return left.length === right.length && left.every((id, index) => id === right[index]);
    };
    if (!sameIds(savedDeck.active_card_ids, deckSnapshot.active)) {
      throw new Error('The queue snapshot does not match the selected saved deck.');
    }
  }
  const id = asNumber((await client.query("SELECT nextval('arena_entries_id_seq') AS id")).rows[0].id);
  const entry = {
    id, user_id: Number(userId), entered_date: zonedDateKey(now, config.timeZone || 'America/Los_Angeles'),
    paid_amount: 0, priority: false, status: 'queued', created_at: now.toISOString(),
    mode: cleanMode,
    deck_id: deck.rows[0]?.id ? Number(deck.rows[0].id) : null,
    deck_name: deck.rows[0]?.name || (cleanMode === 'draft' ? 'Draft Arena' : ''),
    deck_snapshot: cleanMode === 'constructed' ? { active: JSON.parse(JSON.stringify(deckSnapshot.active)), snapshot_at: now.toISOString() } : null
  };
  await client.query(`
    INSERT INTO arena_entries(id,user_id,status,joined_at,source_order,data)
    VALUES($1,$2,'queued',$3,$4,$5::jsonb)
  `, [id, Number(userId), entry.created_at, id, JSON.stringify(entry)]);
  const queuedCount = asNumber((await client.query(
    "SELECT count(*)::integer AS count FROM arena_entries WHERE status='queued' AND COALESCE(data->>'mode','constructed')=$1",
    [cleanMode]
  )).rows[0].count);
  if (queuedCount >= 10) {
    const result = await assignArenaMatchupsWithClient(client, { now, random, catalog });
    return { ...entry, matchmakingTriggered: true, matchmaking: result };
  }
  await saveArenaMeta(client, meta);
  return entry;
}

export const enterArenaQueuePostgres = (pool, input) => withTransaction(pool, client => enterArenaQueueWithClient(client, input));
export const assignArenaMatchupsPostgres = (pool, input) => withTransaction(pool, client => assignArenaMatchupsWithClient(client, input));
