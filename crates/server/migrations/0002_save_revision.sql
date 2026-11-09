-- 자동 저장 순서(R2, backend.md §7.2). 브라우저가 늘려 가며 보내는 저장 순서 번호다.
-- PUT은 저장된 것보다 큰 revision만 받는다. 늦게 도착한 옛 요청이 새 요청을 덮지 못한다.
ALTER TABLE layouts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ui_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE watchlist_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision  INTEGER NOT NULL
) STRICT;

INSERT INTO watchlist_revision (singleton, revision) VALUES (1, 0);
