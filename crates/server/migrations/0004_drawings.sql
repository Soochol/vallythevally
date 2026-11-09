-- 드로잉(#6, docs/design/drawing-proposal.md §5.2). tool과 점 수는 서버의 DrawingTool이 검사한다.
-- layout_id에 ON DELETE가 없다. 레이아웃을 지울 때 그 범위 드로잉의 처리는 Q7이 정한다. 그 전에는 외래 키가 막는다.
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
