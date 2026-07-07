import { IMPORT_TABLES } from './stateCodec.js';

export const TABLE_COLUMNS = Object.freeze({
  app_documents: ['document_key', 'data'],
  users: ['id', 'username', 'password_hash', 'display_name', 'role', 'balance', 'created_at', 'source_order', 'data'],
  bets: ['id', 'user_id', 'week', 'status', 'bet_kind', 'series_key', 'prop_key', 'stake', 'payout', 'created_at', 'settled_at', 'source_order', 'data'],
  balance_transactions: ['id', 'user_id', 'week', 'amount', 'kind', 'category', 'created_at', 'source_order', 'data'],
  casino_spins: ['id', 'user_id', 'wager', 'payout', 'created_at', 'source_order', 'data'],
  shot_doctor_runs: ['id', 'user_id', 'week', 'status', 'created_at', 'source_order', 'data'],
  horse_entities: ['entity_type', 'entity_key', 'user_id', 'source_order', 'data'],
  wut_memberships: ['user_id', 'wut_coins', 'source_order', 'data'],
  owned_cards: ['id', 'user_id', 'card_identity', 'edition', 'source_order', 'data'],
  owned_boosts: ['id', 'user_id', 'consumed', 'source_order', 'data'],
  owned_trinkets: ['id', 'user_id', 'family', 'rarity', 'attached_card_id', 'source_order', 'data'],
  wut_decks: ['id', 'user_id', 'name', 'source_order', 'data'],
  pack_purchases: ['id', 'user_id', 'status', 'pack_kind', 'pack_type', 'created_at', 'source_order', 'data'],
  card_records: ['collection', 'record_key', 'user_id', 'record_id', 'source_order', 'data'],
  wut_transactions: ['id', 'user_id', 'amount', 'kind', 'created_at', 'source_order', 'data'],
  arena_ratings: ['user_id', 'rating', 'data'],
  arena_entries: ['id', 'user_id', 'status', 'joined_at', 'source_order', 'data'],
  arena_matches: ['match_key', 'numeric_id', 'match_kind', 'status', 'current_player_id', 'turn_deadline', 'created_at', 'source_order', 'data'],
  arena_placements: ['match_key', 'placement_index', 'user_id', 'slot', 'card_id', 'data'],
  draft_presets: ['id', 'preset_key', 'source_order', 'data'],
  draft_events: ['id', 'phase', 'visibility', 'starts_at', 'paused_at', 'updated_at', 'source_order', 'data'],
  draft_entrants: ['event_id', 'entrant_index', 'user_id', 'status', 'source_order', 'data'],
  draft_boosters: ['event_id', 'booster_key', 'current_owner_user_id', 'booster_number', 'awaiting_pass', 'source_order', 'data'],
  draft_picks: ['event_id', 'pick_key', 'user_id', 'booster_number', 'source_order', 'data'],
  draft_inventories: ['event_id', 'user_id', 'archived', 'data'],
  draft_decks: ['event_id', 'user_id', 'archived', 'data'],
  draft_rounds: ['event_id', 'round_number', 'source_order', 'data'],
  draft_matches: ['event_id', 'match_key', 'status', 'current_player_id', 'turn_deadline', 'round_number', 'source_order', 'data'],
  draft_match_placements: ['event_id', 'match_key', 'placement_index', 'user_id', 'slot', 'card_id', 'data'],
  draft_logs: ['event_id', 'log_index', 'log_type', 'created_at', 'data']
});

const jsonColumns = new Set(['data']);

export async function insertStateRows(client, table, rows, batchSize = 100) {
  if (!rows?.length) return 0;
  const columns = TABLE_COLUMNS[table];
  if (!columns) throw new Error(`No import column definition exists for ${table}.`);
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        const value = row[column];
        values.push(jsonColumns.has(column) ? JSON.stringify(value) : value);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(',')})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, values);
    inserted += batch.length;
  }
  return inserted;
}

export async function clearImportedState(client) {
  await client.query(`TRUNCATE ${[...IMPORT_TABLES, 'import_runs'].join(', ')} RESTART IDENTITY CASCADE`);
}

const ID_SEQUENCES = Object.freeze({
  users: 'users_id_seq',
  bets: 'bets_id_seq',
  balance_transactions: 'balance_transactions_id_seq',
  casino_spins: 'casino_spins_id_seq',
  shot_doctor_runs: 'shot_doctor_runs_id_seq',
  owned_cards: 'owned_cards_id_seq',
  owned_boosts: 'owned_boosts_id_seq',
  owned_trinkets: 'owned_trinkets_id_seq',
  wut_decks: 'wut_decks_id_seq',
  pack_purchases: 'pack_purchases_id_seq',
  wut_transactions: 'wut_transactions_id_seq',
  arena_entries: 'arena_entries_id_seq',
  draft_presets: 'draft_presets_id_seq',
  draft_events: 'draft_events_id_seq'
});

export async function synchronizeRuntimeSequences(client) {
  for (const [table, sequence] of Object.entries(ID_SEQUENCES)) {
    await client.query(
      `SELECT setval($1::regclass, COALESCE((SELECT max(id) + 1 FROM ${table}), 1), false)`,
      [sequence]
    );
  }
  await client.query(`
    SELECT setval(
      'arena_matches_numeric_id_seq',
      COALESCE((SELECT max(numeric_id) + 1 FROM arena_matches WHERE match_kind='arena'), 1),
      false
    )
  `);
}

export async function readStateRows(client) {
  const rows = {};
  for (const table of IMPORT_TABLES) rows[table] = (await client.query(`SELECT * FROM ${table}`)).rows;
  return rows;
}

export async function databaseCountManifest(client) {
  const counts = {};
  for (const table of IMPORT_TABLES) counts[table] = Number((await client.query(`SELECT count(*)::bigint AS count FROM ${table}`)).rows[0].count);
  return { counts };
}
