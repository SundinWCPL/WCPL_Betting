CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_documents (
  document_key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id bigint PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  balance bigint NOT NULL DEFAULT 0,
  created_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  week integer NOT NULL,
  status text NOT NULL,
  bet_kind text NOT NULL,
  series_key text,
  prop_key text,
  stake bigint NOT NULL DEFAULT 0,
  payout bigint,
  created_at timestamptz,
  settled_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS bets_user_week_idx ON bets(user_id, week);
CREATE INDEX IF NOT EXISTS bets_week_status_idx ON bets(week, status);

CREATE TABLE IF NOT EXISTS balance_transactions (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  week integer,
  amount bigint NOT NULL,
  kind text NOT NULL,
  category text,
  created_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS balance_transactions_user_idx ON balance_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS casino_spins (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  wager bigint NOT NULL DEFAULT 0,
  payout bigint NOT NULL DEFAULT 0,
  created_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS casino_spins_user_idx ON casino_spins(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shot_doctor_runs (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  status text,
  created_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS shot_doctor_runs_user_idx ON shot_doctor_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS horse_entities (
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  user_id bigint,
  source_order integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(entity_type, entity_key)
);
CREATE INDEX IF NOT EXISTS horse_entities_type_user_idx ON horse_entities(entity_type, user_id);

CREATE TABLE IF NOT EXISTS wut_memberships (
  user_id bigint PRIMARY KEY REFERENCES users(id),
  wut_coins bigint NOT NULL DEFAULT 0,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS owned_cards (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  card_identity text NOT NULL,
  edition text,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS owned_cards_user_idx ON owned_cards(user_id, id);
CREATE INDEX IF NOT EXISTS owned_cards_identity_idx ON owned_cards(card_identity);

CREATE TABLE IF NOT EXISTS owned_boosts (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  consumed boolean NOT NULL DEFAULT false,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS owned_boosts_user_idx ON owned_boosts(user_id, consumed);

CREATE TABLE IF NOT EXISTS owned_trinkets (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  family text NOT NULL,
  rarity text NOT NULL,
  attached_card_id bigint,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS owned_trinkets_user_idx ON owned_trinkets(user_id, attached_card_id);

CREATE TABLE IF NOT EXISTS wut_decks (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  name text NOT NULL,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS wut_decks_user_idx ON wut_decks(user_id, id);

CREATE TABLE IF NOT EXISTS pack_purchases (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  status text NOT NULL,
  pack_kind text,
  pack_type text,
  created_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_purchases_user_status_idx ON pack_purchases(user_id, status);

CREATE TABLE IF NOT EXISTS card_records (
  collection text NOT NULL,
  record_key text NOT NULL,
  user_id bigint,
  record_id bigint,
  source_order integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(collection, record_key)
);
CREATE INDEX IF NOT EXISTS card_records_collection_user_idx ON card_records(collection, user_id);

CREATE TABLE IF NOT EXISTS wut_transactions (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  amount bigint NOT NULL,
  kind text NOT NULL,
  created_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS wut_transactions_user_idx ON wut_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS arena_ratings (
  user_id bigint PRIMARY KEY REFERENCES users(id),
  rating numeric NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_entries (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  status text NOT NULL,
  joined_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_entries_queue_idx ON arena_entries(status, joined_at);

CREATE TABLE IF NOT EXISTS arena_matches (
  match_key text PRIMARY KEY,
  numeric_id bigint,
  match_kind text NOT NULL DEFAULT 'arena',
  status text NOT NULL,
  current_player_id bigint,
  turn_deadline timestamptz,
  created_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_matches_status_deadline_idx ON arena_matches(status, turn_deadline);
CREATE INDEX IF NOT EXISTS arena_matches_current_player_idx ON arena_matches(current_player_id, status);

CREATE TABLE IF NOT EXISTS arena_placements (
  match_key text NOT NULL REFERENCES arena_matches(match_key) ON DELETE CASCADE,
  placement_index integer NOT NULL,
  user_id bigint,
  slot text,
  card_id bigint,
  data jsonb NOT NULL,
  PRIMARY KEY(match_key, placement_index)
);
CREATE INDEX IF NOT EXISTS arena_placements_user_idx ON arena_placements(user_id);

CREATE TABLE IF NOT EXISTS draft_presets (
  id bigint PRIMARY KEY,
  preset_key text,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_events (
  id bigint PRIMARY KEY,
  phase text NOT NULL,
  visibility text,
  starts_at timestamptz,
  paused_at timestamptz,
  updated_at timestamptz,
  source_order integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS draft_events_phase_idx ON draft_events(phase, starts_at);

CREATE TABLE IF NOT EXISTS draft_entrants (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  entrant_index integer NOT NULL,
  user_id bigint NOT NULL REFERENCES users(id),
  status text NOT NULL,
  source_order integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, entrant_index)
);
CREATE INDEX IF NOT EXISTS draft_entrants_event_user_idx ON draft_entrants(event_id, user_id);

CREATE TABLE IF NOT EXISTS draft_boosters (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  booster_key text NOT NULL,
  current_owner_user_id bigint,
  booster_number integer,
  awaiting_pass boolean NOT NULL DEFAULT false,
  source_order integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, booster_key)
);
CREATE INDEX IF NOT EXISTS draft_boosters_owner_idx ON draft_boosters(event_id, current_owner_user_id, booster_number);

CREATE TABLE IF NOT EXISTS draft_picks (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  pick_key text NOT NULL,
  user_id bigint,
  booster_number integer,
  source_order integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, pick_key)
);

CREATE TABLE IF NOT EXISTS draft_inventories (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  user_id bigint NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, user_id, archived)
);

CREATE TABLE IF NOT EXISTS draft_decks (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  user_id bigint NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, user_id, archived)
);

CREATE TABLE IF NOT EXISTS draft_rounds (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  source_order integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, round_number)
);

CREATE TABLE IF NOT EXISTS draft_matches (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  match_key text NOT NULL,
  status text NOT NULL,
  current_player_id bigint,
  turn_deadline timestamptz,
  round_number integer,
  source_order integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, match_key)
);
CREATE INDEX IF NOT EXISTS draft_matches_status_deadline_idx ON draft_matches(status, turn_deadline);
CREATE INDEX IF NOT EXISTS draft_matches_current_player_idx ON draft_matches(current_player_id, status);

CREATE TABLE IF NOT EXISTS draft_match_placements (
  event_id bigint NOT NULL,
  match_key text NOT NULL,
  placement_index integer NOT NULL,
  user_id bigint,
  slot text,
  card_id bigint,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, match_key, placement_index),
  FOREIGN KEY(event_id, match_key) REFERENCES draft_matches(event_id, match_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_logs (
  event_id bigint NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  log_index integer NOT NULL,
  log_type text,
  created_at timestamptz,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id, log_index)
);

CREATE TABLE IF NOT EXISTS import_runs (
  id bigserial PRIMARY KEY,
  source_sha256 text NOT NULL,
  source_bytes bigint NOT NULL,
  source_path text,
  manifest jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
