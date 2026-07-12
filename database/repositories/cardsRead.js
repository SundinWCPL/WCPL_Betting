import { WUT_LAUNCH_TRINKET_EFFECTS, normalizeWutTrinketEffect } from '../../services/wutBalanceRules.js';
import { DEFAULT_BOOST_PACK_CONFIG, DEFAULT_RARITY_THRESHOLDS, normalizeRarityThresholds } from '../../services/cards.js';

function normalizeCardsConfig(config = {}) {
  const next = JSON.parse(JSON.stringify(config || {}));
  next.boostPack = {
    ...DEFAULT_BOOST_PACK_CONFIG,
    ...(next.boostPack || {}),
    commonRareOdds: {
      ...DEFAULT_BOOST_PACK_CONFIG.commonRareOdds,
      ...(next.boostPack?.commonRareOdds || {})
    },
    guaranteedHighOdds: {
      ...DEFAULT_BOOST_PACK_CONFIG.guaranteedHighOdds,
      ...(next.boostPack?.guaranteedHighOdds || {})
    }
  };
  next.rarityThresholds = normalizeRarityThresholds(next.rarityThresholds || DEFAULT_RARITY_THRESHOLDS);
  const trinketEffects = next.wut?.trinketEffects;
  if (trinketEffects) {
    for (const [family, rarities] of Object.entries(WUT_LAUNCH_TRINKET_EFFECTS)) {
      trinketEffects[family] ||= {};
      for (const rarity of Object.keys(rarities)) {
        trinketEffects[family][rarity] = normalizeWutTrinketEffect(family, rarity, trinketEffects[family][rarity] ?? rarities[rarity]);
      }
    }
  }
  return next;
}

export async function getCardsMetaPostgres(pool) {
  const row = (await pool.query("SELECT data FROM app_documents WHERE document_key='cards_meta'")).rows[0];
  if (!row) throw new Error('Required PostgreSQL document is missing: cards_meta.');
  const data = row.data || {};
  return { ...data, config: normalizeCardsConfig(data.config || {}) };
}

export async function getCardsConfigPostgres(pool) {
  return (await getCardsMetaPostgres(pool)).config || {};
}

export async function getCardsAdminStatePostgres(pool) {
  const cardsMeta = await getCardsMetaPostgres(pool);
  const arenaDoc = await pool.query("SELECT data FROM app_documents WHERE document_key='arena_meta'");
  const members = await pool.query(`SELECT m.user_id,m.wut_coins,m.data,u.display_name FROM wut_memberships m JOIN users u ON u.id=m.user_id ORDER BY lower(u.display_name),m.user_id`);
  const adjustments = await pool.query(`SELECT t.id,t.user_id,t.amount,t.kind,t.created_at,t.data,u.display_name FROM wut_transactions t JOIN users u ON u.id=t.user_id WHERE t.kind='admin_wut_coin_adjustment' ORDER BY t.created_at DESC NULLS LAST,t.id DESC LIMIT 20`);
  const refundSummary = await pool.query(`
    WITH wut_refunds AS (
      SELECT COALESCE(array_agg((data->>'source_transaction_id')::bigint), ARRAY[]::bigint[]) AS ids
      FROM wut_transactions WHERE kind='trinket_removal_refund' AND data ? 'source_transaction_id'
    ), mushy_refunds AS (
      SELECT COALESCE(array_agg((data->>'source_transaction_id')::bigint), ARRAY[]::bigint[]) AS ids
      FROM balance_transactions WHERE kind='wut_trinket_removal_refund' AND data ? 'source_transaction_id'
    )
    SELECT
      (SELECT count(*)::int FROM wut_transactions,wut_refunds WHERE kind='trinket_removal' AND amount < 0 AND NOT (id = ANY(wut_refunds.ids))) AS wut_count,
      (SELECT COALESCE(sum(abs(amount)),0)::bigint FROM wut_transactions,wut_refunds WHERE kind='trinket_removal' AND amount < 0 AND NOT (id = ANY(wut_refunds.ids))) AS wut_amount,
      (SELECT count(*)::int FROM balance_transactions,mushy_refunds WHERE kind='wut_trinket_removal' AND amount < 0 AND NOT (id = ANY(mushy_refunds.ids))) AS mushy_count,
      (SELECT COALESCE(sum(abs(amount)),0)::bigint FROM balance_transactions,mushy_refunds WHERE kind='wut_trinket_removal' AND amount < 0 AND NOT (id = ANY(mushy_refunds.ids))) AS mushy_amount,
      (SELECT count(*)::int FROM owned_cards WHERE data ? 'trinket_id' AND data->>'trinket_id' IS NOT NULL AND data->>'trinket_id' <> 'null') AS attached_card_count,
      (SELECT count(*)::int FROM owned_trinkets WHERE attached_card_id IS NOT NULL OR (data ? 'attached_card_id' AND data->>'attached_card_id' IS NOT NULL AND data->>'attached_card_id' <> 'null')) AS attached_trinket_count,
      (SELECT count(*)::int FROM wut_decks) AS saved_deck_count
  `);
  const totals = await pool.query(`SELECT
      (SELECT count(*) FROM owned_cards)::int AS owned_cards,
      (SELECT count(*) FROM owned_boosts)::int AS owned_boosts,
      (SELECT count(*) FROM owned_trinkets)::int AS owned_trinkets,
      (SELECT count(*) FROM wut_decks)::int AS saved_decks,
      (SELECT count(*) FROM wut_memberships)::int AS wut_members,
      (SELECT count(*) FROM pack_purchases)::int AS packs,
      (SELECT count(*) FROM arena_entries WHERE status='queued')::int AS queued_arena_entries,
      (SELECT count(*) FROM arena_matches WHERE match_kind='arena' AND status IN ('drafting','choosing_first','active','scoring','ready'))::int AS active_arena_matches`);
  const rulesVoidCounts = await pool.query(`
    SELECT
      (SELECT count(*) FROM arena_matches
        WHERE match_kind='arena'
          AND status IN ('drafting','choosing_first','active','scoring','ready')
          AND NOT (data ? 'wut_rewards_awarded_at')
          AND NOT (data ? 'elo_updated_at'))::int AS arena_count,
      (SELECT count(*) FROM draft_matches
        WHERE status IN ('active','scoring')
          AND NOT (data ? 'wut_rewards_awarded_at')
          AND NOT (data ? 'elo_updated_at'))::int AS draft_count
  `);
  const arenaMeta = arenaDoc.rows[0]?.data || {};
  const activeMatchVoidAction = cardsMeta.rolloutActions?.lastActiveMatchVoid || cardsMeta.rolloutActions?.voidOngoingMatchesV1 || null;
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
    trinketRemovalRefunds: {
      wutCount: Number(refundSummary.rows[0]?.wut_count || 0),
      wutAmount: Number(refundSummary.rows[0]?.wut_amount || 0),
      mushyCount: Number(refundSummary.rows[0]?.mushy_count || 0),
      mushyAmount: Number(refundSummary.rows[0]?.mushy_amount || 0),
      attachedCardCount: Number(refundSummary.rows[0]?.attached_card_count || 0),
      attachedTrinketCount: Number(refundSummary.rows[0]?.attached_trinket_count || 0),
      savedDeckCount: Number(refundSummary.rows[0]?.saved_deck_count || 0),
      pending: Number(refundSummary.rows[0]?.wut_count || 0) + Number(refundSummary.rows[0]?.mushy_count || 0) +
        Number(refundSummary.rows[0]?.attached_card_count || 0) + Number(refundSummary.rows[0]?.attached_trinket_count || 0)
    },
    rulesUpdateVoid: {
      completedAt: activeMatchVoidAction?.completed_at || null,
      rewardAmount: 30,
      pendingMatchCount: Number(rulesVoidCounts.rows[0]?.arena_count || 0) + Number(rulesVoidCounts.rows[0]?.draft_count || 0),
      result: activeMatchVoidAction
    },
    totals: {
      ownedCards: totals.rows[0].owned_cards, ownedBoosts: totals.rows[0].owned_boosts,
      ownedTrinkets: totals.rows[0].owned_trinkets, savedDecks: totals.rows[0].saved_decks,
      wutMembers: totals.rows[0].wut_members, packs: totals.rows[0].packs,
      queuedArenaEntries: totals.rows[0].queued_arena_entries, activeArenaMatches: totals.rows[0].active_arena_matches
    }
  };
}
