export async function getCardsMetaPostgres(pool) {
  const row = (await pool.query("SELECT data FROM app_documents WHERE document_key='cards_meta'")).rows[0];
  if (!row) throw new Error('Required PostgreSQL document is missing: cards_meta.');
  return row.data || {};
}

export async function getCardsConfigPostgres(pool) {
  return (await getCardsMetaPostgres(pool)).config || {};
}

export async function getCardsAdminStatePostgres(pool) {
  const cardsMeta = await getCardsMetaPostgres(pool);
  const arenaDoc = await pool.query("SELECT data FROM app_documents WHERE document_key='arena_meta'");
  const members = await pool.query(`SELECT m.user_id,m.wut_coins,m.data,u.display_name FROM wut_memberships m JOIN users u ON u.id=m.user_id ORDER BY lower(u.display_name),m.user_id`);
  const adjustments = await pool.query(`SELECT t.id,t.user_id,t.amount,t.kind,t.created_at,t.data,u.display_name FROM wut_transactions t JOIN users u ON u.id=t.user_id WHERE t.kind='admin_wut_coin_adjustment' ORDER BY t.created_at DESC NULLS LAST,t.id DESC LIMIT 20`);
  const totals = await pool.query(`SELECT
      (SELECT count(*) FROM owned_cards)::int AS owned_cards,
      (SELECT count(*) FROM owned_boosts)::int AS owned_boosts,
      (SELECT count(*) FROM owned_trinkets)::int AS owned_trinkets,
      (SELECT count(*) FROM wut_decks)::int AS saved_decks,
      (SELECT count(*) FROM wut_memberships)::int AS wut_members,
      (SELECT count(*) FROM pack_purchases)::int AS packs,
      (SELECT count(*) FROM arena_entries WHERE status='queued')::int AS queued_arena_entries,
      (SELECT count(*) FROM arena_matches WHERE match_kind='arena' AND status='active')::int AS active_arena_matches`);
  const arenaMeta = arenaDoc.rows[0]?.data || {};
  return {
    config: cardsMeta.config || {},
    positionOverrides: { ...(cardsMeta.positionOverrides || {}) },
    tierOverrides: { ...(cardsMeta.tierOverrides || {}) },
    calculatedTiers: { ...(cardsMeta.calculatedTiers || {}) },
    arenaConfig: { ...(arenaMeta.config || {}) },
    wutUsers: members.rows.map(row => ({
      userId: Number(row.user_id), displayName: row.display_name || `User #${row.user_id}`,
      wutCoins: Number(row.wut_coins || 0), starterOpened: Boolean(row.data?.starter_opened_at)
    })),
    recentWutAdjustments: adjustments.rows.map(row => ({
      ...(row.data || {}), id: Number(row.id), user_id: Number(row.user_id), amount: Number(row.amount),
      kind: row.kind, created_at: row.created_at, displayName: row.display_name || `User #${row.user_id}`
    })),
    totals: {
      ownedCards: totals.rows[0].owned_cards, ownedBoosts: totals.rows[0].owned_boosts,
      ownedTrinkets: totals.rows[0].owned_trinkets, savedDecks: totals.rows[0].saved_decks,
      wutMembers: totals.rows[0].wut_members, packs: totals.rows[0].packs,
      queuedArenaEntries: totals.rows[0].queued_arena_entries, activeArenaMatches: totals.rows[0].active_arena_matches
    }
  };
}
