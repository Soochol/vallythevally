CREATE TABLE sync_documents (
  kind           TEXT    NOT NULL CHECK (kind IN ('watchlists', 'screens', 'ui_state', 'layout', 'drawing')),
  id             TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  revision       INTEGER NOT NULL CHECK (revision >= 0),
  acked_revision INTEGER CHECK (acked_revision IS NULL OR acked_revision >= 0),
  deleted        INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (kind, id)
) STRICT;

CREATE TABLE sync_refusals (
  kind      TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  revision  INTEGER NOT NULL,
  direction TEXT    NOT NULL CHECK (direction IN ('push', 'pull')),
  reason    TEXT    NOT NULL,
  PRIMARY KEY (kind, id)
) STRICT;

CREATE TABLE sync_state (
  singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor       INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  initial_done INTEGER NOT NULL DEFAULT 0 CHECK (initial_done IN (0, 1))
) STRICT;
INSERT INTO sync_state (singleton) VALUES (1);

INSERT INTO sync_documents (kind, id, revision) SELECT 'watchlists', 'main', revision FROM watchlist_revision WHERE singleton = 1;
INSERT INTO sync_documents (kind, id, revision) SELECT 'screens', 'main', revision FROM screens WHERE singleton = 1;
INSERT INTO sync_documents (kind, id, revision) SELECT 'ui_state', 'main', revision FROM ui_state WHERE singleton = 1;
INSERT INTO sync_documents (kind, id, revision) SELECT 'layout', id, revision FROM layouts;
INSERT INTO sync_documents (kind, id, revision) SELECT 'drawing', id, revision FROM drawings;
