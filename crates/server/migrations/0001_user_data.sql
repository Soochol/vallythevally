-- 사용자 자료(backend.md §7.2, ADR 0006). #3: 관심종목, 레이아웃 기본 1칸, 화면 상태.
-- 드로잉(#6)과 알림(#8)은 그 단계의 마이그레이션에서 더한다.

CREATE TABLE watchlist (
  symbol   TEXT    PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE layouts (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  arrangement TEXT    NOT NULL CHECK (arrangement IN ('1','2h','2v','3','4')),
  sync        TEXT    NOT NULL CHECK (json_valid(sync)),
  position    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE layout_cells (
  layout_id      TEXT    NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  slot           INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 3),
  symbol         TEXT    NOT NULL,
  venue          TEXT    CHECK (venue IN ('combined','krx','nxt')),
  period         TEXT    NOT NULL,
  symbol_link    INTEGER NOT NULL CHECK (symbol_link IN (0,1)),
  chart_settings TEXT    NOT NULL CHECK (json_valid(chart_settings)),
  PRIMARY KEY (layout_id, slot),
  CHECK ((symbol LIKE 'IDX:%') = (venue IS NULL))
) STRICT;

CREATE TABLE ui_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state     TEXT    NOT NULL CHECK (json_valid(state))
) STRICT;

-- 기본 레이아웃: 1칸, 코스피 지수 일봉. 레이아웃이 0개인 상태는 없다.
INSERT INTO layouts (id, name, arrangement, sync, position, updated_at)
VALUES ('01900000-0000-7000-8000-000000000001', '기본', '1', '{"crosshair":true,"scroll":true}', 0, 0);

INSERT INTO layout_cells (layout_id, slot, symbol, venue, period, symbol_link, chart_settings)
VALUES ('01900000-0000-7000-8000-000000000001', 0, 'IDX:001', NULL, 'D', 0,
        '{"v":1,"style":"candle","scale":"normal","indicators":[],"compare":[],"panels":[]}');

INSERT INTO ui_state (singleton, state)
VALUES (1, '{"lastLayoutId":"01900000-0000-7000-8000-000000000001","theme":"dark"}');
