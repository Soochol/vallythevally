-- 관심종목 여러 목록(#37). 지금의 목록 하나는 첫 목록 '기본'이 된다. watchlist_revision은 목록 전체의 저장 순서 번호로 그대로 쓴다.

CREATE TABLE watchlists (
  id       TEXT    PRIMARY KEY,
  name     TEXT    NOT NULL UNIQUE,
  position INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE watchlist_items (
  list_id  TEXT    NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol   TEXT    NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (list_id, symbol),
  UNIQUE (list_id, position)
) STRICT;

INSERT INTO watchlists (id, name, position) VALUES ('01900000-0000-7000-8000-000000000002', '기본', 0);

INSERT INTO watchlist_items (list_id, symbol, position)
SELECT '01900000-0000-7000-8000-000000000002', symbol, position FROM watchlist;

DROP TABLE watchlist;
