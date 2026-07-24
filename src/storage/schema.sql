CREATE TABLE IF NOT EXISTS candidates (
  item_id           TEXT PRIMARY KEY,
  card_name         TEXT NOT NULL,
  listing_price     REAL NOT NULL,
  target_price      REAL NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'GBP',
  listing_url       TEXT NOT NULL,
  found_at          TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  -- the matcher's verdict on this candidate, kept even when it's a "no alert"
  -- so misses can be reviewed later
  verdict           TEXT NOT NULL,          -- 'alert' | 'no_alert'
  verdict_reasoning TEXT,

  alerted           INTEGER NOT NULL DEFAULT 0,

  -- user's own follow-through, independent of the verdict above
  status            TEXT NOT NULL DEFAULT 'found'
                       CHECK (status IN ('found','offered','bought','sold','flipped'))
);

CREATE INDEX IF NOT EXISTS idx_candidates_found_at ON candidates(found_at);
CREATE INDEX IF NOT EXISTS idx_candidates_card_name ON candidates(card_name);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
