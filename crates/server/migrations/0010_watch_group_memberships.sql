CREATE TABLE watch_group_memberships (
  group_id TEXT    NOT NULL,
  list_id  TEXT    NOT NULL,
  symbol   TEXT    NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, symbol),
  UNIQUE (group_id, position),
  FOREIGN KEY (group_id, list_id) REFERENCES watch_groups(id, list_id) ON DELETE CASCADE,
  FOREIGN KEY (list_id, symbol) REFERENCES watchlist_items(list_id, symbol) ON DELETE CASCADE
) STRICT;

INSERT INTO watch_group_memberships (group_id, list_id, symbol, position)
SELECT group_id, list_id, symbol, position FROM watch_group_items;

DROP TABLE watch_group_items;
ALTER TABLE watch_group_memberships RENAME TO watch_group_items;
