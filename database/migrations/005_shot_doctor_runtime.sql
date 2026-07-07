ALTER TABLE shot_doctor_runs ADD COLUMN IF NOT EXISTS week integer;
UPDATE shot_doctor_runs
SET week = COALESCE(NULLIF(data->>'week', '')::integer, 1)
WHERE week IS NULL;
ALTER TABLE shot_doctor_runs ALTER COLUMN week SET NOT NULL;

CREATE INDEX IF NOT EXISTS shot_doctor_runs_user_week_idx
  ON shot_doctor_runs(user_id, week);

CREATE UNIQUE INDEX IF NOT EXISTS shot_doctor_runs_one_active_per_user
  ON shot_doctor_runs(user_id)
  WHERE status = 'active';
