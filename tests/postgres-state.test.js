import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeJsonState, encodeJsonState, stateManifest } from '../database/stateCodec.js';

const fixture = {
  settings: { currentWeek: 3, maintenanceMode: true },
  users: [{ id: 1, username: 'admin', password_hash: 'hash', display_name: 'Admin', role: 'admin', balance: 900, created_at: '2026-07-06T00:00:00.000Z' }],
  bets: [{ id: 1, user_id: 1, week: 3, status: 'open', stake: 100, payout: null, created_at: '2026-07-06T00:01:00.000Z' }],
  transactions: [{ id: 1, user_id: 1, amount: 1000, kind: 'starting_balance', created_at: '2026-07-06T00:00:00.000Z' }, { id: 2, user_id: 1, amount: -100, kind: 'bet_stake', created_at: '2026-07-06T00:01:00.000Z' }],
  oddsAdjustments: { series: { 3: { sample: 2 } } },
  casino: {
    jackpotAmount: 1005, spins: [{ id: 1, user_id: 1, wager: 5, payout: 0, created_at: '2026-07-06T00:02:00.000Z' }],
    shotDoctorRuns: [{ id: 1, user_id: 1, status: 'complete', payout: 0 }],
    horseRacing: { config: { maxBet: 100 }, horses: [{ id: 1, owner_user_id: 1 }], ownerRewards: [], races: [], bets: [], nextRaceId: 1, chat: { cardDate: '2026-07-06', nextMessageId: 2, messages: [{ id: 1, user_id: 1, message: 'hi' }] } }
  },
  cards: {
    config: { wut: { rewards: { winner: 60 } } }, positionOverrides: {}, tierOverrides: {}, calculatedTiers: {},
    ownedCards: [{ id: 1, user_id: 1, card_identity: 'S2|ALL|name:test', edition: 'S2' }],
    ownedBoosts: [{ id: 1, user_id: 1, consumed: false }], lineups: [], packPurchases: [], weekReviews: [],
    wutMemberships: [{ user_id: 1, wutCoins: 1000 }], trinkets: [{ id: 1, user_id: 1, family: 'safety_net', rarity: 'common', attached_card_id: 1 }],
    decks: [{ id: 1, user_id: 1, name: 'Deck 1', active_card_ids: [1] }], trinketShops: [],
    wutTransactions: [{ id: 1, user_id: 1, amount: 1000, kind: 'starter_pack_bonus' }], missionPeriods: [], missionBetOpportunities: [],
    arena: {
      config: { defaultElo: 1000 }, ratings: { 1: 1000 }, entries: [{ id: 1, user_id: 1, status: 'matched' }],
      matches: [{ id: 1, player_ids: [1, 2], first_player_id: 1, turn_index: 1, status: 'active', placements: [{ user_id: 1, slot: 'F1', card_id: 1 }] }],
      debugMatches: [], nextEntryId: 2, nextMatchId: 2
    },
    draftEvents: {
      nextEventId: 2, nextPresetId: 2, presets: [{ id: 1, key: 'nightly' }],
      events: [{
        id: 1, phase: 'tournament', config: { basic: { visibility: 'public' }, scheduling: {} }, entrants: [{ user_id: 1, status: 'active' }], logs: [{ type: 'created' }],
        draft: { boosters: [{ id: 1, current_owner_user_id: 1, booster_number: 1, items: [] }], picks: [{ id: 1, user_id: 1, booster_number: 1 }] },
        inventories: { 1: { cards: [{ id: 1 }] } }, archived_inventories: {}, decks: { 1: { active_card_ids: [1] } }, archived_decks: {},
        tournament: { round: 1, rounds: [{ number: 1, match_ids: [1] }], matches: [{ id: 1, round: 1, player_ids: [1, 2], first_player_id: 1, turn_index: 0, status: 'active', placements: [] }] }
      }]
    }
  },
  nextUserId: 2, nextBetId: 2, nextTransactionId: 3, nextCasinoSpinId: 2, nextShotDoctorRunId: 2,
  nextOwnedCardId: 2, nextOwnedBoostId: 2, nextOwnedTrinketId: 2, nextDeckId: 2, nextWutTransactionId: 2, nextPackPurchaseId: 1
};

test('PostgreSQL state codec preserves the complete legacy JSON shape', () => {
  const rows = encodeJsonState(fixture);
  assert.deepEqual(decodeJsonState(rows), fixture);
  const manifest = stateManifest(fixture, rows);
  assert.equal(manifest.counts.users, 1);
  assert.equal(manifest.counts.arena_placements, 1);
  assert.equal(manifest.counts.draft_matches, 1);
  assert.equal(manifest.money.mushybuxBalances, 900);
  assert.equal(manifest.money.wutCoinBalances, 1000);
});

test('initial PostgreSQL migration contains the concurrency-critical tables and indexes', () => {
  const sql = fs.readFileSync(new URL('../database/migrations/001_initial.sql', import.meta.url), 'utf8');
  for (const table of ['users', 'bets', 'casino_spins', 'owned_cards', 'arena_matches', 'arena_placements', 'draft_events', 'draft_boosters', 'draft_matches']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /arena_matches_status_deadline_idx/);
  assert.match(sql, /draft_matches_current_player_idx/);
});

test('runtime sequences cover every generated top-level numeric identifier', () => {
  const sql = fs.readFileSync(new URL('../database/migrations/003_runtime_sequences.sql', import.meta.url), 'utf8');
  for (const table of ['users', 'bets', 'balance_transactions', 'casino_spins', 'owned_cards', 'owned_boosts', 'owned_trinkets', 'wut_decks', 'pack_purchases', 'wut_transactions', 'arena_entries', 'draft_presets', 'draft_events']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval`));
    assert.match(sql, new RegExp(`SELECT max\\(id\\) \\+ 1 FROM ${table}`));
  }
});
