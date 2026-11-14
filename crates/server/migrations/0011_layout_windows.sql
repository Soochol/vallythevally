CREATE TABLE layout_windows (
  layout_id      TEXT    NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  id             TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  position       INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  link           TEXT    CHECK (link IN ('a','b','c')),
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
SELECT layout_id, 'cell-' || slot, slot, 'chart', CASE symbol_link WHEN 1 THEN 'a' END, symbol, venue, period, chart_settings
FROM layout_cells;

INSERT INTO layout_windows (layout_id, id, position, kind)
SELECT l.id, side.kind, COALESCE((SELECT MAX(slot) + 1 FROM layout_cells c WHERE c.layout_id = l.id), 0) + side.offset, side.kind
FROM layouts l
CROSS JOIN (SELECT 'watchlist' AS kind, 0 AS offset UNION ALL SELECT 'screener', 1 UNION ALL SELECT 'objects', 2) side;

ALTER TABLE layouts ADD COLUMN placement TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(placement) AND json_type(placement) = 'object');
ALTER TABLE layouts DROP COLUMN arrangement;
DROP TABLE layout_cells;

CREATE TABLE drawings_by_window (
  id         TEXT    PRIMARY KEY,
  symbol     TEXT    NOT NULL,
  tool       TEXT    NOT NULL,
  points     TEXT    NOT NULL CHECK (json_valid(points)),
  text       TEXT,
  style      TEXT    NOT NULL CHECK (json_valid(style)),
  locked     INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  periods    TEXT    CHECK (periods IS NULL OR json_valid(periods)),
  z          REAL    NOT NULL,
  group_name TEXT    CHECK (group_name IS NULL OR length(group_name) BETWEEN 1 AND 100),
  scope      TEXT    NOT NULL DEFAULT 'symbol' CHECK (scope IN ('symbol', 'layout', 'cell')),
  layout_id  TEXT    REFERENCES layouts(id),
  window_id  TEXT,
  updated_at INTEGER NOT NULL,
  revision   INTEGER NOT NULL,
  CHECK ((scope = 'symbol' AND layout_id IS NULL AND window_id IS NULL)
      OR (scope = 'layout' AND layout_id IS NOT NULL AND window_id IS NULL)
      OR (scope = 'cell'   AND layout_id IS NOT NULL AND window_id IS NOT NULL)),
  FOREIGN KEY (layout_id, window_id) REFERENCES layout_windows (layout_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

INSERT INTO drawings_by_window (id, symbol, tool, points, text, style, locked, hidden, periods, z, group_name, scope, layout_id, window_id, updated_at, revision)
SELECT d.id, d.symbol, d.tool, d.points, d.text, d.style, d.locked, d.hidden, d.periods, d.z, d.group_name,
       CASE WHEN d.scope = 'cell' AND w.id IS NULL THEN 'layout' ELSE d.scope END,
       d.layout_id, w.id, d.updated_at, d.revision
FROM drawings d
LEFT JOIN layout_windows w ON d.scope = 'cell' AND w.layout_id = d.layout_id AND w.id = 'cell-' || d.slot;

DROP TABLE drawings;
ALTER TABLE drawings_by_window RENAME TO drawings;
CREATE INDEX drawings_by_symbol ON drawings (symbol);
