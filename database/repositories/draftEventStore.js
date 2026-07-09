import { insertStateRows } from '../stateStore.js';

const clone = value => JSON.parse(JSON.stringify(value));
const without = (value, keys) => {
  const copy = clone(value || {});
  for (const key of keys) delete copy[key];
  return copy;
};
const timestamp = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const keyed = (row, index) => `${String(row?.id ?? row?.key ?? row?.user_id ?? `row-${index}`)}:${index}`;
const currentPlayer = match => {
  if (match?.status !== 'active') return null;
  const first = Number(match.first_player_id);
  const second = Number((match.player_ids || []).find(id => Number(id) !== first));
  return Number(match.turn_index || 0) % 2 === 0 ? first : second;
};

const aggregateSelect = whereClause => `
  SELECT e.*,
    COALESCE((SELECT jsonb_agg(data ORDER BY entrant_index) FROM draft_entrants WHERE event_id=e.id), '[]'::jsonb) AS entrants,
    COALESCE((SELECT jsonb_agg(data ORDER BY source_order) FROM draft_boosters WHERE event_id=e.id), '[]'::jsonb) AS boosters,
    COALESCE((SELECT jsonb_agg(data ORDER BY source_order) FROM draft_picks WHERE event_id=e.id), '[]'::jsonb) AS picks,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'archived',archived,'data',data)) FROM draft_inventories WHERE event_id=e.id), '[]'::jsonb) AS inventories,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'archived',archived,'data',data)) FROM draft_decks WHERE event_id=e.id), '[]'::jsonb) AS decks,
    COALESCE((SELECT jsonb_agg(data ORDER BY source_order) FROM draft_rounds WHERE event_id=e.id), '[]'::jsonb) AS rounds,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('match_key',match_key,'data',data) ORDER BY source_order) FROM draft_matches WHERE event_id=e.id), '[]'::jsonb) AS matches,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('match_key',match_key,'data',data) ORDER BY match_key,placement_index) FROM draft_match_placements WHERE event_id=e.id), '[]'::jsonb) AS placements,
    COALESCE((SELECT jsonb_agg(data ORDER BY log_index) FROM draft_logs WHERE event_id=e.id), '[]'::jsonb) AS logs
  FROM draft_events e ${whereClause}
`;

function eventFromRow(eventRow) {
  const event = clone(eventRow.data || {});
  event.id = Number(eventRow.id);
  event.phase = eventRow.phase;
  event.entrants = clone(eventRow.entrants || []);
  event.logs = clone(eventRow.logs || []);
  event.inventories = {};
  event.archived_inventories = {};
  for (const row of eventRow.inventories || []) (row.archived ? event.archived_inventories : event.inventories)[String(row.user_id)] = clone(row.data);
  event.decks = {};
  event.archived_decks = {};
  for (const row of eventRow.decks || []) (row.archived ? event.archived_decks : event.decks)[String(row.user_id)] = clone(row.data);
  event.draft = { ...(event.draft || {}), boosters: clone(eventRow.boosters || []), picks: clone(eventRow.picks || []) };
  const placementMap = new Map();
  for (const row of eventRow.placements || []) {
    if (!placementMap.has(row.match_key)) placementMap.set(row.match_key, []);
    placementMap.get(row.match_key).push(clone(row.data));
  }
  event.tournament = {
    ...(event.tournament || {}),
    rounds: clone(eventRow.rounds || []),
    matches: (eventRow.matches || []).map(row => ({ ...clone(row.data), placements: placementMap.get(row.match_key) || [] }))
  };
  return event;
}

export async function lockAndLoadDraftEvent(client, eventId) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8243000 + Number(eventId)]);
  const eventRow = (await client.query(aggregateSelect('WHERE e.id=$1 FOR UPDATE OF e'), [Number(eventId)])).rows[0];
  if (!eventRow) throw new Error('WUT Draft Event not found.');
  return eventFromRow(eventRow);
}

export async function getDraftEventPostgres(pool, eventId) {
  const row = (await pool.query(aggregateSelect('WHERE e.id=$1'), [Number(eventId)])).rows[0];
  if (!row) throw new Error('WUT Draft Event not found.');
  return eventFromRow(row);
}

export async function getDraftEventLobbyPostgres(pool, { eventId = null, userId = null, includePrivate = false } = {}) {
  const rows = eventId == null
    ? (await pool.query(aggregateSelect(''))).rows
    : (await pool.query(aggregateSelect('WHERE e.id=$1'), [Number(eventId)])).rows;
  const events = rows.map(eventFromRow).filter(event => includePrivate || event.config?.basic?.visibility === 'public');
  const userIds = [...new Set(events.flatMap(event => event.entrants || []).map(item => Number(item.user_id)).filter(Number.isFinite))];
  const names = new Map();
  if (userIds.length) {
    const users = await pool.query('SELECT id,username,display_name FROM users WHERE id=ANY($1::bigint[])', [userIds]);
    for (const user of users.rows) names.set(Number(user.id), user.display_name || user.username || `Player ${user.id}`);
  }
  return events.map(event => {
    const entrant = (event.entrants || []).find(item => Number(item.user_id) === Number(userId) && item.status === 'active') || null;
    return {
      ...event,
      entrants: (event.entrants || []).map(item => ({ ...item, display_name: names.get(Number(item.user_id)) || `Player ${item.user_id}` })),
      active_entrant_count: (event.entrants || []).filter(item => item.status === 'active').length,
      joined_by_user: Boolean(entrant),
      user_entrant: entrant ? clone(entrant) : null
    };
  }).sort((a, b) => new Date(a.config?.scheduling?.startsAt || a.created_at).getTime() - new Date(b.config?.scheduling?.startsAt || b.created_at).getTime());
}

function eventRows(event) {
  const eventId = Number(event.id);
  const eventData = without(event, ['entrants', 'logs', 'inventories', 'archived_inventories', 'decks', 'archived_decks', 'draft', 'tournament']);
  eventData.draft = without(event.draft || {}, ['boosters', 'picks']);
  eventData.tournament = without(event.tournament || {}, ['rounds', 'matches']);
  const rows = {
    draft_entrants: [], draft_boosters: [], draft_picks: [], draft_inventories: [], draft_decks: [],
    draft_rounds: [], draft_matches: [], draft_match_placements: [], draft_logs: []
  };
  (event.entrants || []).forEach((data, index) => rows.draft_entrants.push({
    event_id: eventId, entrant_index: index, user_id: Number(data.user_id), status: String(data.status || 'active'), source_order: index, data: clone(data)
  }));
  (event.draft?.boosters || []).forEach((data, index) => rows.draft_boosters.push({
    event_id: eventId, booster_key: keyed(data, index), current_owner_user_id: data.current_owner_user_id == null ? null : Number(data.current_owner_user_id),
    booster_number: data.booster_number == null ? null : Number(data.booster_number), awaiting_pass: Boolean(data.awaiting_pass), source_order: index, data: clone(data)
  }));
  (event.draft?.picks || []).forEach((data, index) => rows.draft_picks.push({
    event_id: eventId, pick_key: keyed(data, index), user_id: data.user_id == null ? null : Number(data.user_id),
    booster_number: data.booster_number == null ? null : Number(data.booster_number), source_order: index, data: clone(data)
  }));
  for (const [userId, data] of Object.entries(event.inventories || {})) rows.draft_inventories.push({ event_id: eventId, user_id: Number(userId), archived: false, data: clone(data) });
  for (const [userId, data] of Object.entries(event.archived_inventories || {})) rows.draft_inventories.push({ event_id: eventId, user_id: Number(userId), archived: true, data: clone(data) });
  for (const [userId, data] of Object.entries(event.decks || {})) rows.draft_decks.push({ event_id: eventId, user_id: Number(userId), archived: false, data: clone(data) });
  for (const [userId, data] of Object.entries(event.archived_decks || {})) rows.draft_decks.push({ event_id: eventId, user_id: Number(userId), archived: true, data: clone(data) });
  (event.tournament?.rounds || []).forEach((data, index) => rows.draft_rounds.push({
    event_id: eventId, round_number: Number(data.number ?? index + 1), source_order: index, data: clone(data)
  }));
  (event.tournament?.matches || []).forEach((match, index) => {
    const matchKey = String(match.id);
    rows.draft_matches.push({
      event_id: eventId, match_key: matchKey, status: String(match.status || 'pending'), current_player_id: currentPlayer(match),
      turn_deadline: timestamp(match.turn_deadline), round_number: match.round == null ? null : Number(match.round),
      source_order: index, data: without(match, ['placements'])
    });
    (match.placements || []).forEach((placement, placementIndex) => rows.draft_match_placements.push({
      event_id: eventId, match_key: matchKey, placement_index: placementIndex,
      user_id: placement.user_id == null ? null : Number(placement.user_id), slot: placement.slot || null,
      card_id: placement.card_id == null ? null : Number(placement.card_id), data: clone(placement)
    }));
  });
  (event.logs || []).forEach((data, index) => rows.draft_logs.push({
    event_id: eventId, log_index: index, log_type: data.type || null, created_at: timestamp(data.created_at), data: clone(data)
  }));
  return { eventData, rows };
}

export async function saveDraftEvent(client, event) {
  const { eventData, rows } = eventRows(event);
  await client.query(`
    UPDATE draft_events SET phase=$2,visibility=$3,starts_at=$4,paused_at=$5,updated_at=$6,data=$7::jsonb WHERE id=$1
  `, [Number(event.id), String(event.phase), event.config?.basic?.visibility || null,
    timestamp(event.config?.scheduling?.startsAt), timestamp(event.paused_at), timestamp(event.updated_at) || new Date().toISOString(), JSON.stringify(eventData)]);
  for (const table of ['draft_match_placements','draft_matches','draft_rounds','draft_decks','draft_inventories','draft_picks','draft_boosters','draft_entrants','draft_logs']) {
    await client.query(`DELETE FROM ${table} WHERE event_id=$1`, [Number(event.id)]);
  }
  for (const [table, values] of Object.entries(rows)) await insertStateRows(client, table, values);
}

export async function saveDraftTournamentEvent(client, event) {
  const { eventData, rows } = eventRows(event);
  await client.query(`
    UPDATE draft_events SET phase=$2,visibility=$3,starts_at=$4,paused_at=$5,updated_at=$6,data=$7::jsonb WHERE id=$1
  `, [Number(event.id), String(event.phase), event.config?.basic?.visibility || null,
    timestamp(event.config?.scheduling?.startsAt), timestamp(event.paused_at), timestamp(event.updated_at) || new Date().toISOString(), JSON.stringify(eventData)]);
  for (const table of ['draft_match_placements', 'draft_matches', 'draft_rounds']) {
    await client.query(`DELETE FROM ${table} WHERE event_id=$1`, [Number(event.id)]);
  }
  for (const table of ['draft_rounds', 'draft_matches', 'draft_match_placements']) {
    await insertStateRows(client, table, rows[table]);
  }
  for (const row of rows.draft_inventories) {
    await client.query(`
      UPDATE draft_inventories SET data=$4::jsonb
      WHERE event_id=$1 AND user_id=$2 AND archived=$3
    `, [row.event_id, row.user_id, row.archived, JSON.stringify(row.data)]);
  }
  await client.query('DELETE FROM draft_logs WHERE event_id=$1', [Number(event.id)]);
  await insertStateRows(client, 'draft_logs', rows.draft_logs);
}

export async function insertDraftEvent(client, event) {
  const { eventData } = eventRows(event);
  await client.query(`
    INSERT INTO draft_events(id,phase,visibility,starts_at,paused_at,updated_at,source_order,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
  `, [Number(event.id), String(event.phase), event.config?.basic?.visibility || null,
    timestamp(event.config?.scheduling?.startsAt), timestamp(event.paused_at), timestamp(event.updated_at) || new Date().toISOString(),
    Number(event.id), JSON.stringify(eventData)]);
  await saveDraftEvent(client, event);
}
