CREATE TABLE drawings (
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
  slot       INTEGER,
  updated_at INTEGER NOT NULL,
  revision   INTEGER NOT NULL,
  CHECK ((scope = 'symbol' AND layout_id IS NULL AND slot IS NULL)
      OR (scope = 'layout' AND layout_id IS NOT NULL AND slot IS NULL)
      OR (scope = 'cell'   AND layout_id IS NOT NULL AND slot IS NOT NULL))
) STRICT;
CREATE INDEX drawings_by_symbol ON drawings (symbol);
