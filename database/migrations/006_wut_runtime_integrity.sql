CREATE UNIQUE INDEX IF NOT EXISTS pack_purchases_one_reveal_per_user
  ON pack_purchases(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS wut_transactions_kind_idx
  ON wut_transactions(user_id, kind, created_at DESC);
