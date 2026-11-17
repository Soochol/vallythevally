CREATE TEMP TABLE layout_windows_kept AS SELECT * FROM layout_windows;

DROP TABLE layout_windows;

CREATE TABLE layout_windows (
  layout_id      TEXT    NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  id             TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  position       INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  link           TEXT    CHECK (link IN ('a','b','c','d','e','f','g','h','i','j')),
  symbol         TEXT,
  venue          TEXT    CHECK (venue IN ('combined','krx','nxt')),
  period         TEXT,
  chart_settings TEXT    CHECK (chart_settings IS NULL OR json_valid(chart_settings)),
  PRIMARY KEY (layout_id, id),
  UNIQUE (layout_id, position),
  CHECK ((kind = 'chart') = (symbol IS NOT NULL AND period IS NOT NULL AND chart_settings IS NOT NULL)),
  CHECK (CASE WHEN kind = 'chart' THEN (symbol LIKE 'IDX:%') = (venue IS NULL) ELSE venue IS NULL END)
) STRICT;

INSERT INTO layout_windows (layout_id, id, position, kind, link, symbol, venue, period, chart_settings)
SELECT layout_id, id, position, kind, link, symbol, venue, period, chart_settings FROM layout_windows_kept;

DROP TABLE layout_windows_kept;
