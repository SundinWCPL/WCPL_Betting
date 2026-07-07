import bcrypt from 'bcryptjs';

const safeUser = row => row ? {
  ...(row.data || {}),
  id: Number(row.id),
  username: row.username,
  display_name: row.display_name || '',
  role: row.role || 'user',
  balance: Number(row.balance || 0),
  created_at: row.created_at,
  password_hash: undefined
} : null;

export async function getUserByIdPostgres(pool, userId) {
  const row = (await pool.query('SELECT * FROM users WHERE id=$1', [Number(userId)])).rows[0];
  if (!row) return null;
  const user = safeUser(row);
  delete user.password_hash;
  return user;
}

export async function authenticatePostgres(pool, username, password) {
  const row = (await pool.query('SELECT * FROM users WHERE lower(username)=lower($1) LIMIT 1', [String(username || '')])).rows[0];
  if (!row || !await bcrypt.compare(String(password || ''), row.password_hash)) return null;
  const user = safeUser(row);
  delete user.password_hash;
  return user;
}

export async function getAdminSettingsPostgres(pool) {
  const row = (await pool.query("SELECT data FROM app_documents WHERE document_key='settings'" )).rows[0];
  const settings = { ...(row?.data || {}) };
  const currentWeek = Number(settings.currentWeek || 1);
  const lockedWeeks = new Set((settings.lockedWeeks || []).map(Number));
  return {
    ...settings,
    currentWeek,
    currentWeekLocked: lockedWeeks.has(currentWeek),
    nextWeekLocked: lockedWeeks.has(currentWeek + 1)
  };
}

export async function getWutMembershipStatePostgres(pool, userId) {
  const row = (await pool.query('SELECT wut_coins,data FROM wut_memberships WHERE user_id=$1', [Number(userId)])).rows[0];
  if (!row) return { joined: false, starterOpened: false, wutCoins: 0 };
  const data = row.data || {};
  return {
    joined: true,
    starterOpened: Boolean(data.starter_opened_at),
    joinFee: Number(data.join_fee || 0),
    joinedAt: data.joined_at || null,
    starterOpenedAt: data.starter_opened_at || null,
    starterCardIds: [...(data.starter_card_ids || [])],
    wutCoins: Number(row.wut_coins || 0),
    deckSlots: Number(data.deck_slots || 3)
  };
}

export async function hasPendingArenaTurnPostgres(pool, userId) {
  const row = (await pool.query(`
    SELECT EXISTS(
      SELECT 1 FROM arena_matches
      WHERE match_kind='arena' AND status='active' AND current_player_id=$1
    ) AS pending
  `, [Number(userId)])).rows[0];
  return Boolean(row?.pending);
}

export async function getPendingWutDraftActionEventIdsPostgres(pool, userId) {
  const playerId = Number(userId);
  const result = await pool.query(`
    SELECT DISTINCT e.id
    FROM draft_events e
    JOIN draft_entrants de ON de.event_id=e.id AND de.user_id=$1 AND de.status='active'
    WHERE
      (e.phase='draft' AND EXISTS(
        SELECT 1 FROM draft_boosters b
        WHERE b.event_id=e.id AND b.current_owner_user_id=$1 AND NOT b.awaiting_pass
      ))
      OR (e.phase='deckbuilding' AND NOT EXISTS(
        SELECT 1 FROM draft_decks d WHERE d.event_id=e.id AND d.user_id=$1 AND NOT d.archived
      ))
      OR (e.phase='tournament' AND EXISTS(
        SELECT 1 FROM draft_matches m
        WHERE m.event_id=e.id AND m.status='active' AND m.current_player_id=$1
      ))
    ORDER BY e.id
  `, [playerId]);
  return result.rows.map(row => Number(row.id));
}
