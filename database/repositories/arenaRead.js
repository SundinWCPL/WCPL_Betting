import { ARENA_DEFAULT_ELO, arenaCurrentPlayerId, arenaTurnCap, maxWutLegalPlacements } from '../../services/arenaRuntime.js';
import { trinketFitsWutPosition } from '../../services/wutBalanceRules.js';

const asNumber = value => Number(value || 0);
const firstPlayerDeciderId = match => Number(match?.first_player_decider_user_id ?? match?.coin_flip_winner_user_id);
const arenaModeOf = value => String(value || 'constructed') === 'draft' ? 'draft' : 'constructed';

export async function getArenaRatingPostgres(pool, userId) {
  const row = (await pool.query('SELECT rating FROM arena_ratings WHERE user_id=$1', [Number(userId)])).rows[0];
  return row ? Number(row.rating) : ARENA_DEFAULT_ELO;
}

export async function getArenaAdminSummaryPostgres(pool, now = new Date()) {
  const [meta, counts] = await Promise.all([
    pool.query("SELECT data FROM app_documents WHERE document_key='arena_meta'"),
    pool.query(`SELECT
      (SELECT count(*)::int FROM arena_entries WHERE status='queued') AS queued,
      (SELECT count(*)::int FROM arena_entries WHERE status='queued' AND COALESCE(data->>'mode','constructed')='draft') AS queued_draft,
      (SELECT count(*)::int FROM arena_entries WHERE status='queued' AND COALESCE(data->>'mode','constructed')='constructed') AS queued_constructed,
      (SELECT count(*)::int FROM arena_matches WHERE match_kind='arena' AND status IN ('drafting','choosing_first','active')) AS active,
      (SELECT count(*)::int FROM arena_matches WHERE match_kind='arena' AND status='ready') AS ready`)
  ]);
  const data = structuredClone(meta.rows[0]?.data || {});
  const config = data.config || {};
  const queued = Number(counts.rows[0]?.queued || 0);
  const queueCounts = {
    draft: Number(counts.rows[0]?.queued_draft || 0),
    constructed: Number(counts.rows[0]?.queued_constructed || 0)
  };
  const queueTrigger = Number(config.queueTrigger || 10);
  const interval = 30 * 60 * 1000;
  const currentSlot = String(Math.floor(now.getTime() / interval));
  return {
    lastMatchmakingAt: data.lastMatchmakingAt || null,
    matchmakingDue: String(data.lastMatchmakingSlot || '') !== currentSlot || Object.values(queueCounts).some(count => count >= queueTrigger),
    queueTriggerReached: Object.values(queueCounts).some(count => count >= queueTrigger),
    nextMatchmakingAt: new Date((Math.floor(now.getTime() / interval) + 1) * interval).toISOString(),
    queued,
    queueCounts,
    active: Number(counts.rows[0]?.active || 0),
    ready: Number(counts.rows[0]?.ready || 0),
    config
  };
}

const currentPlayer = arenaCurrentPlayerId;

function timerPaused(now, config) {
  const hour = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone || 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).find(part => part.type === 'hour')?.value || 0);
  const start = Number(config.pauseStartHour ?? 0);
  const end = Number(config.pauseEndHour ?? 8);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function publicMatch(match, userId, names, config, wutConfig, now) {
  const players = (match.player_ids || []).map(id => ({
    id: Number(id),
    displayName: names.get(Number(id))?.displayName || `Player ${id}`,
    elo: names.get(Number(id))?.rating ?? ARENA_DEFAULT_ELO
  }));
  const ownPlacements = (match.placements || []).filter(row => Number(row.user_id) === Number(userId));
  const loadBonus = Math.max(0, ...ownPlacements.filter(row => row.card_snapshot?.trinket?.family === 'booster_cable')
    .map(row => asNumber(row.card_snapshot?.trinket?.effect?.loadBonus)));
  const current = match.status === 'active' ? currentPlayer(match) : null;
  const cardsRequired = current == null ? 0 : maxWutLegalPlacements({
    cards: match.deck_snapshots?.[String(current)]?.active || [],
    placements: match.placements || [],
    userId: current,
    slotPowerAllowance: wutConfig.slotPowerAllowance || 1,
    trinketFits: trinketFitsWutPosition
  }, arenaTurnCap(match));
  return {
    ...match,
    players,
    opponent: players.find(player => player.id !== Number(userId)) || null,
    mode: match.mode || 'constructed',
    is_draft_prep_turn: match.status === 'drafting' && !(match.draft_loadouts?.[String(userId)]?.submitted_at),
    is_first_player_choice_turn: match.status === 'choosing_first' && firstPlayerDeciderId(match) === Number(userId),
    current_player_id: current,
    cards_required_this_turn: match.status === 'active' ? cardsRequired : 0,
    is_your_turn: match.status === 'drafting' ? !(match.draft_loadouts?.[String(userId)]?.submitted_at)
      : match.status === 'choosing_first' ? firstPlayerDeciderId(match) === Number(userId)
      : current === Number(userId),
    timer_paused: ['drafting', 'choosing_first', 'active'].includes(match.status) && timerPaused(now, config),
    boost_load_cap: asNumber(wutConfig.boostLoadCap || 5) + loadBonus,
    boost_load_used: ownPlacements.reduce((sum, row) => sum + asNumber(row.boost_load), 0)
  };
}

export async function getArenaStateForUserPostgres(pool, userId, now = new Date()) {
  const playerId = Number(userId);
  const [documents, queuedEntries, queueCount, queueCountRows, matchRows, ratings, completedRows] = await Promise.all([
    pool.query("SELECT document_key,data FROM app_documents WHERE document_key IN ('arena_meta','cards_meta')"),
    pool.query("SELECT data FROM arena_entries WHERE user_id=$1 AND status='queued' ORDER BY joined_at,id", [playerId]),
    pool.query("SELECT count(*)::integer AS count FROM arena_entries WHERE status='queued'"),
    pool.query("SELECT COALESCE(data->>'mode','constructed') AS mode,count(*)::integer AS count FROM arena_entries WHERE status='queued' GROUP BY 1"),
    pool.query(`
      SELECT m.match_key,m.status,m.data,
        COALESCE((SELECT jsonb_agg(p.data ORDER BY p.placement_index) FROM arena_placements p WHERE p.match_key=m.match_key), '[]'::jsonb) AS placements
      FROM arena_matches m
      WHERE m.match_kind='arena' AND m.data->'player_ids' @> $1::jsonb
      ORDER BY m.numeric_id DESC
    `, [JSON.stringify([playerId])]),
    pool.query(`
      SELECT r.user_id,r.rating,u.username,u.display_name
      FROM arena_ratings r JOIN users u ON u.id=r.user_id
      ORDER BY r.rating DESC,r.user_id
    `),
    pool.query("SELECT data FROM arena_matches WHERE match_kind='arena' AND status='completed'")
  ]);
  const docs = Object.fromEntries(documents.rows.map(row => [row.document_key, row.data || {}]));
  const config = structuredClone(docs.arena_meta?.config || {});
  const wutConfig = docs.cards_meta?.config?.wut || {};
  const names = new Map(ratings.rows.map(row => [Number(row.user_id), {
    displayName: row.display_name || row.username || `Player ${row.user_id}`,
    rating: Number(row.rating)
  }]));
  const matches = matchRows.rows.map(row => ({ ...(row.data || {}), status: row.status, placements: row.placements || [] }))
    .map(match => publicMatch(match, playerId, names, config, wutConfig, now));
  const activeMatches = matches.filter(match => ['drafting', 'choosing_first', 'active'].includes(match.status));
  const queueCounts = { draft: 0, constructed: 0 };
  for (const row of queueCountRows.rows) queueCounts[arenaModeOf(row.mode)] = Number(row.count || 0);
  const ownQueuedEntries = queuedEntries.rows.map(row => structuredClone(row.data || {}));
  const ownQueuedByMode = Object.fromEntries(['draft', 'constructed'].map(mode => [
    mode,
    ownQueuedEntries.find(entry => arenaModeOf(entry.mode) === mode) || null
  ]));
  const resolved = matches.filter(match => match.status === 'completed' ||
    (match.status === 'ready' && (match.revealed_by || []).map(Number).includes(playerId)));
  const interval = 30 * 60 * 1000;
  const completed = completedRows.rows.map(row => row.data || {});
  const participantIds = new Set(completed.flatMap(match => (match.player_ids || []).map(Number)));
  const leaderboard = ratings.rows.filter(row => participantIds.has(Number(row.user_id))).map(row => {
    const playerMatches = completed.filter(match => (match.player_ids || []).map(Number).includes(Number(row.user_id)));
    const wins = playerMatches.filter(match => Number(match.winner_user_id) === Number(row.user_id)).length;
    const losses = playerMatches.filter(match => match.winner_user_id != null && Number(match.winner_user_id) !== Number(row.user_id)).length;
    return {
      userId: Number(row.user_id), displayName: row.display_name || row.username,
      rating: Number(row.rating), wins, losses, draws: playerMatches.length - wins - losses,
      matches: playerMatches.length
    };
  }).sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.losses - b.losses || a.displayName.localeCompare(b.displayName))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  return {
    config,
    nextMatchmakingAt: new Date((Math.floor(now.getTime() / interval) + 1) * interval).toISOString(),
    queueCount: Number(queueCount.rows[0]?.count || 0),
    queueCounts,
    queuedEntry: ownQueuedEntries[0] ? structuredClone(ownQueuedEntries[0]) : null,
    queuedEntries: Object.fromEntries(Object.entries(ownQueuedByMode).map(([mode, entry]) => [mode, entry ? structuredClone(entry) : null])),
    activeCounts: Object.fromEntries(['draft', 'constructed'].map(mode => [
      mode,
      activeMatches.filter(match => arenaModeOf(match.mode) === mode).length
    ])),
    rating: names.get(playerId)?.rating ?? ARENA_DEFAULT_ELO,
    record: {
      wins: resolved.filter(match => Number(match.winner_user_id) === playerId).length,
      losses: resolved.filter(match => match.winner_user_id != null && Number(match.winner_user_id) !== playerId).length,
      draws: resolved.filter(match => match.winner_user_id == null).length
    },
    leaderboard,
    activeMatches,
    readyMatches: matches.filter(match => match.status === 'ready' && !(match.revealed_by || []).map(Number).includes(playerId)),
    history: matches.filter(match => match.status === 'completed' ||
      (match.status === 'ready' && (match.revealed_by || []).map(Number).includes(playerId))),
    cancelledMatches: matches.filter(match => match.status === 'cancelled'),
    serverNow: now.toISOString()
  };
}

export async function getArenaMatchesNeedingScoringPostgres(pool) {
  const result = await pool.query(`
    SELECT m.match_key,m.data,
      COALESCE((SELECT jsonb_agg(p.data ORDER BY p.placement_index) FROM arena_placements p WHERE p.match_key=m.match_key), '[]'::jsonb) AS placements
    FROM arena_matches m
    WHERE m.match_kind='arena' AND m.status='scoring'
    ORDER BY m.numeric_id
  `);
  return result.rows.map(row => ({ ...(row.data || {}), arena_match_key: row.match_key, status: 'scoring', placements: row.placements || [] }));
}

export async function getArenaAdminMatchStatePostgres(pool, { userId = null } = {}) {
  const selectedUserId = Number(userId) || null;
  const matchRows = await pool.query(`SELECT m.numeric_id,m.status,m.data,COALESCE((SELECT jsonb_agg(p.data ORDER BY p.placement_index) FROM arena_placements p WHERE p.match_key=m.match_key),'[]'::jsonb) AS placements FROM arena_matches m WHERE m.match_kind='arena' ORDER BY m.numeric_id DESC`);
  const userRows = await pool.query('SELECT id,username,display_name FROM users ORDER BY lower(display_name),id');
  const names = new Map(userRows.rows.map(row => [Number(row.id), row.display_name || row.username || `Player ${row.id}`]));
  const matches = matchRows.rows.map(row => { const match = { ...(row.data || {}), id: Number(row.numeric_id ?? row.data?.id), status: row.status, placements: row.placements || [] };
    const players = (match.player_ids || []).map(id => ({ id: Number(id), displayName: names.get(Number(id)) || `Player ${id}` })); const currentPlayerId = match.status === 'active' ? currentPlayer(match) : null;
    return { ...match, players, playerLabel: players.map(player => player.displayName).join(' vs '), currentPlayerId,
      currentPlayerName: players.find(player => player.id === currentPlayerId)?.displayName || '', placementCount: match.placements.length };
  });
  const users = userRows.rows.map(row => ({ id:Number(row.id), displayName:names.get(Number(row.id)), matchCount:matches.filter(match => match.player_ids.map(Number).includes(Number(row.id))).length })).filter(row => row.matchCount);
  return { selectedUserId, activeMatches: matches.filter(match => ['drafting','choosing_first','active','scoring'].includes(match.status)),
    history: matches.filter(match => ['ready','completed','cancelled'].includes(match.status) && (!selectedUserId || match.player_ids.map(Number).includes(selectedUserId))), users };
}
