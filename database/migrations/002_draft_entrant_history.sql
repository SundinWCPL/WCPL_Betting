ALTER TABLE draft_entrants ADD COLUMN IF NOT EXISTS entrant_index integer;
UPDATE draft_entrants SET entrant_index = source_order WHERE entrant_index IS NULL;
ALTER TABLE draft_entrants ALTER COLUMN entrant_index SET NOT NULL;
ALTER TABLE draft_entrants DROP CONSTRAINT IF EXISTS draft_entrants_pkey;
ALTER TABLE draft_entrants ADD PRIMARY KEY(event_id, entrant_index);
CREATE INDEX IF NOT EXISTS draft_entrants_event_user_idx ON draft_entrants(event_id, user_id);
