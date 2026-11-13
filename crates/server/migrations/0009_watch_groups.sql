CREATE TABLE watch_groups (
  id       TEXT    PRIMARY KEY,
  list_id  TEXT    NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE (list_id, name),
  UNIQUE (list_id, position),
  UNIQUE (id, list_id)
) STRICT;

CREATE TABLE watch_group_items (
  group_id TEXT    NOT NULL,
  list_id  TEXT    NOT NULL,
  symbol   TEXT    NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, symbol),
  UNIQUE (group_id, position),
  UNIQUE (list_id, symbol),
  FOREIGN KEY (group_id, list_id) REFERENCES watch_groups(id, list_id) ON DELETE CASCADE,
  FOREIGN KEY (list_id, symbol) REFERENCES watchlist_items(list_id, symbol) ON DELETE CASCADE
) STRICT;
