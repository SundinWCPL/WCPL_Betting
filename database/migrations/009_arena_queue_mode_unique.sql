DROP INDEX IF EXISTS arena_entries_one_queued_per_user;

CREATE UNIQUE INDEX IF NOT EXISTS arena_entries_one_queued_per_user_mode
  ON arena_entries(user_id, (COALESCE(data->>'mode', 'constructed')))
  WHERE status = 'queued';
