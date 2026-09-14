-- sfs-agent-db — safe views only.
--
-- Design rule: if a column could hold a score, margin, or point weight, it does
-- not exist. The schema is the second enforcement layer (§8.1). A leak would
-- require an ALTER TABLE, not a bug.
--
-- No h, a, period, linescores, resultMargin, confidence.score, factors, or any
-- yardage column. Not filtered at read time — absent.

DROP TABLE IF EXISTS games;

CREATE TABLE games (
  id                    TEXT PRIMARY KEY,
  sport                 TEXT NOT NULL,

  -- Pre-game identity. Free-text filter dimensions (§6).
  home                  TEXT NOT NULL,
  away                  TEXT NOT NULL,
  league                TEXT,
  date                  TEXT,          -- display form, e.g. "Sat, Sep 5"
  date_key              TEXT NOT NULL, -- "2026-09-05", drives recency filter
  ts                    INTEGER NOT NULL,
  status                TEXT,

  -- Pre-game numbers, permitted by invariant 1.
  home_rank             INTEGER,
  away_rank             INTEGER,

  -- Availability (§6).
  broadcast             TEXT,
  watch_name            TEXT,
  watch_url             TEXT,
  collinsworth_warning  INTEGER,       -- 0/1

  -- Disclosed outcome shape. Named exception, §4.3.
  cls                   TEXT NOT NULL CHECK (cls IN ('scorefest','watchworthy','watchable')),

  -- Closed-enum filter tags (§3.3). CHECK constraints are the point: an
  -- out-of-vocabulary value is rejected by the database, not by the code that
  -- wrote it.
  competitiveness       TEXT NOT NULL CHECK (competitiveness IN ('nail_biter','close','competitive')),
  scoring               TEXT NOT NULL CHECK (scoring IN ('shootout','balanced')),
  overtime              INTEGER NOT NULL CHECK (overtime IN (0,1)),
  ranked                TEXT NOT NULL CHECK (ranked IN ('both','one','neither')),
  runtime_bucket        TEXT NOT NULL CHECK (runtime_bucket IN ('under_2h','2_to_3h','over_3h')),

  -- Output of the ported redaction layer. JSON array of 1-3 approved phrases.
  -- The full disclosure budget for this game; there is no richer view anywhere.
  phrases               TEXT NOT NULL,

  ingested_at           INTEGER NOT NULL
);

CREATE INDEX idx_games_filter  ON games (sport, date_key, competitiveness, scoring);
CREATE INDEX idx_games_recency ON games (sport, ts DESC);

-- Ingest run log. Evidence that a run happened and how much it dropped —
-- useful when a query comes back empty and you need to know whether that is
-- real scarcity or a broken fetch.
CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id        TEXT PRIMARY KEY,
  sport         TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  fetched       INTEGER,
  recommendable INTEGER,
  written       INTEGER,
  pruned        INTEGER,
  corpus_size   INTEGER,
  error         TEXT
);
