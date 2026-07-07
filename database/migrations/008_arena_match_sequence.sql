CREATE SEQUENCE IF NOT EXISTS arena_matches_numeric_id_seq;
SELECT setval(
  'arena_matches_numeric_id_seq',
  COALESCE((SELECT max(numeric_id) + 1 FROM arena_matches WHERE match_kind='arena'), 1),
  false
);
