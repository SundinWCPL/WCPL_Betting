import { withTransaction } from '../postgres.js';
import { ARENA_DEFAULT_ELO, nextArenaDeadline, pairArenaEntries } from '../../services/arenaRuntime.js';
import { zonedDateKey } from '../../services/zonedTime.js';

const asNumber = value => Number(value || 0);
const MATCHMAKING_MINUTES = 30;

async function lockArenaMeta(client) {
  const result = await client.query("SELECT data FROM app_documents WHERE document_key='arena_meta' FOR UPDATE");
  if (!result.rows[0]) throw new Error('Required PostgreSQL document is missing: arena_meta.');
  return result.rows[0].data || {};
}

async function saveArenaMeta(client, meta) {
  await client.query("UPDATE app_documents SET data=$2::jsonb,updated_at=now() WHERE document_key=$1", ['arena_meta', JSON.stringify(meta)]);
}

export async function assignArenaMatchupsWithClient(client, { now = new Date(), random = Math.random } = {}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242060]);
  const meta = await lockArenaMeta(client);
  const config = meta.config || {};
  const queued = (await client.query("SELECT id,user_id,data FROM arena_entries WHERE status='queued' ORDER BY joined_at,id FOR UPDATE")).rows;
  const active = (await client.query("SELECT data FROM arena_matches WHERE status IN ('active','scoring')")).rows.map(row => row.data || {});
  const eligible = queued.filter(row => row.data?.deck_snapshot &&
    active.filter(match => (match.player_ids || []).map(Number).includes(Number(row.user_id))).length < asNumber(config.maxActiveMatches || 3)
  ).map(row => ({ ...row.data, id: asNumber(row.id), user_id: asNumber(row.user_id) }));
  const ratings = new Map((await client.query('SELECT user_id,rating FROM arena_ratings')).rows.map(row => [asNumber(row.user_id), Number(row.rating)]));
  const prior = new Set((await client.query("SELECT data FROM arena_matches WHERE status NOT IN ('cancelled','voided')")).rows.map(row =>
    (row.data?.player_ids || []).map(Number).sort((a, b) => a - b).join(':')
  ));
  const { pairs, unmatched } = pairArenaEntries(
    eligible,
    entry => ratings.get(Number(entry.user_id)) ?? ARENA_DEFAULT_ELO,
    (a, b) => prior.has([Number(a.user_id), Number(b.user_id)].sort((x, y) => x - y).join(':'))
  );
  const created = [];
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
      player_ids: [Number(first.user_id), Number(second.user_id)],
      entry_ids: [first.id, second.id],
      first_player_id: Number(firstPlayer),
      turn_index: 0,
      turn_deadline: nextArenaDeadline(now, config),
      rules_version: 2,
      deck_snapshots: {
        [String(first.user_id)]: JSON.parse(JSON.stringify(first.deck_snapshot)),
        [String(second.user_id)]: JSON.parse(JSON.stringify(second.deck_snapshot))
      },
      entry_fee: 0,
      prize_amount: 60,
      starting_elo: {
        [String(first.user_id)]: ratings.get(Number(first.user_id)) ?? ARENA_DEFAULT_ELO,
        [String(second.user_id)]: ratings.get(Number(second.user_id)) ?? ARENA_DEFAULT_ELO
      },
      placements: [], status: 'active', scores: null, winner_user_id: null,
      winnings_claimed_at: null, created_at: now.toISOString(), resolved_at: null, completed_at: null
    };
    await client.query(`
      INSERT INTO arena_matches(match_key,numeric_id,match_kind,status,current_player_id,turn_deadline,created_at,source_order,data)
      VALUES($1,$2,'arena','active',$3,$4,$5,$6,$7::jsonb)
    `, [String(id), id, firstPlayer, match.turn_deadline, match.created_at, id, JSON.stringify({ ...match, placements: undefined })]);
    created.push(id);
  }
  if (unmatched) {
    unmatched.priority = true;
    unmatched.carried_at = now.toISOString();
    await client.query('UPDATE arena_entries SET data=$2::jsonb WHERE id=$1', [unmatched.id, JSON.stringify(unmatched)]);
  }
  meta.lastMatchmakingSlot = String(Math.floor(now.getTime() / (MATCHMAKING_MINUTES * 60000)));
  meta.lastMatchmakingAt = now.toISOString();
  await saveArenaMeta(client, meta);
  return { createdMatchIds: created, unmatchedUserId: unmatched?.user_id || null, lastMatchmakingAt: now.toISOString() };
}

export async function enterArenaQueueWithClient(client, {
  userId, deckId, deckSnapshot, now = new Date(), random = Math.random
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242060]);
  const meta = await lockArenaMeta(client);
  const config = meta.config || {};
  const activeCount = asNumber((await client.query(`
    SELECT count(*)::integer AS count FROM arena_matches
    WHERE status IN ('active','scoring') AND data->'player_ids' @> $1::jsonb
  `, [JSON.stringify([Number(userId)])])).rows[0].count);
  if (activeCount >= asNumber(config.maxActiveMatches || 3)) throw new Error(`You already have ${config.maxActiveMatches} active WUT matches.`);
  const deck = await client.query('SELECT id,name,data FROM wut_decks WHERE id=$1 AND user_id=$2', [Number(deckId), Number(userId)]);
  if (!deck.rows[0]) throw new Error('Select a saved deck before entering the queue.');
  if (!deckSnapshot || !Array.isArray(deckSnapshot.active) || !Array.isArray(deckSnapshot.bench) ||
      deckSnapshot.active.length < 5 || deckSnapshot.active.length > 8 || deckSnapshot.bench.length !== 5) {
    throw new Error('That deck is not queue-ready.');
  }
  if (deckSnapshot.bench.map(card => card.position).sort().join('') !== 'DDFFG' || deckSnapshot.bench.some(card => Number(card.power) > 2)) {
    throw new Error('That deck’s Safety Bench is no longer legal. Update it before queueing.');
  }
  const savedDeck = deck.rows[0].data || {};
  const sameIds = (saved, snapshot) => {
    const left = (saved || []).map(Number).sort((a, b) => a - b);
    const right = (snapshot || []).map(card => Number(card.card_id)).sort((a, b) => a - b);
    return left.length === right.length && left.every((id, index) => id === right[index]);
  };
  if (!sameIds(savedDeck.active_card_ids, deckSnapshot.active) || !sameIds(savedDeck.bench_card_ids, deckSnapshot.bench)) {
    throw new Error('The queue snapshot does not match the selected saved deck.');
  }
  const id = asNumber((await client.query("SELECT nextval('arena_entries_id_seq') AS id")).rows[0].id);
  const entry = {
    id, user_id: Number(userId), entered_date: zonedDateKey(now, config.timeZone || 'America/Los_Angeles'),
    paid_amount: 0, priority: false, status: 'queued', created_at: now.toISOString(),
    deck_id: Number(deck.rows[0].id), deck_name: deck.rows[0].name,
    deck_snapshot: { ...JSON.parse(JSON.stringify(deckSnapshot)), snapshot_at: now.toISOString() }
  };
  await client.query(`
    INSERT INTO arena_entries(id,user_id,status,joined_at,source_order,data)
    VALUES($1,$2,'queued',$3,$4,$5::jsonb)
  `, [id, Number(userId), entry.created_at, id, JSON.stringify(entry)]);
  const queuedCount = asNumber((await client.query("SELECT count(*)::integer AS count FROM arena_entries WHERE status='queued'")).rows[0].count);
  if (queuedCount >= 10) {
    const result = await assignArenaMatchupsWithClient(client, { now, random });
    return { ...entry, matchmakingTriggered: true, matchmaking: result };
  }
  await saveArenaMeta(client, meta);
  return entry;
}

export const enterArenaQueuePostgres = (pool, input) => withTransaction(pool, client => enterArenaQueueWithClient(client, input));
export const assignArenaMatchupsPostgres = (pool, input) => withTransaction(pool, client => assignArenaMatchupsWithClient(client, input));
