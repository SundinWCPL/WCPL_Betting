CREATE UNIQUE INDEX IF NOT EXISTS balance_transactions_weekly_allowance_unique
  ON balance_transactions(user_id, week)
  WHERE kind = 'weekly_allowance';

CREATE UNIQUE INDEX IF NOT EXISTS bets_open_series_unique
  ON bets(user_id, week, series_key)
  WHERE status = 'open' AND bet_kind = 'series';

CREATE UNIQUE INDEX IF NOT EXISTS bets_open_prop_unique
  ON bets(user_id, week, (data->>'division_id'), (data->>'prop_category'))
  WHERE status = 'open' AND bet_kind = 'prop';
