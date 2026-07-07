CREATE UNIQUE INDEX IF NOT EXISTS arena_entries_one_queued_per_user
  ON arena_entries(user_id)
  WHERE status = 'queued';
