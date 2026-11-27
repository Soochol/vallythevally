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
  list           TEXT    CHECK (list IS NULL OR (kind = 'watchlist' AND length(list) > 0)),
  screen         TEXT    CHECK (screen IS NULL OR (kind = 'screener' AND length(screen) > 0)),
  ranking        TEXT    CHECK (ranking IS NULL OR (kind = 'ranking' AND json_valid(ranking))),
  broker_view    TEXT    CHECK (broker_view IS NULL OR (kind = 'brokers' AND broker_view IN ('board', 'list', 'table', 'transfer'))),
  broker_cards   TEXT    CHECK (broker_cards IS NULL OR (kind = 'brokers' AND broker_cards IN ('bars', 'both', 'numbers'))),
  PRIMARY KEY (layout_id, id),
  UNIQUE (layout_id, position),
  CHECK (CASE
    WHEN kind = 'chart' THEN symbol IS NOT NULL AND period IS NOT NULL AND chart_settings IS NOT NULL
    WHEN kind IN ('trades', 'book', 'program', 'brokers', 'order', 'premarket') THEN period IS NULL AND chart_settings IS NULL AND (symbol IS NULL OR symbol NOT LIKE 'IDX:%')
    ELSE symbol IS NULL AND period IS NULL AND chart_settings IS NULL
  END),
  CHECK (CASE kind WHEN 'chart' THEN (symbol LIKE 'IDX:%') = (venue IS NULL) WHEN 'order' THEN venue IS NOT NULL ELSE venue IS NULL END),
  CHECK ((kind = 'ranking') = (ranking IS NOT NULL))
) STRICT;

INSERT INTO layout_windows (layout_id, id, position, kind, link, symbol, venue, period, chart_settings, list, screen, ranking, broker_view, broker_cards)
SELECT layout_id, id, position, kind, link, symbol, venue, period, chart_settings, list, screen, ranking, broker_view, broker_cards FROM layout_windows_kept;

DROP TABLE layout_windows_kept;
