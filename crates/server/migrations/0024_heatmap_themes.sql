CREATE TABLE heatmap_themes (
  id       TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  name     TEXT    NOT NULL UNIQUE,
  position INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE heatmap_theme_items (
  theme_id TEXT    NOT NULL REFERENCES heatmap_themes(id) ON DELETE CASCADE,
  symbol   TEXT    NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (theme_id, symbol),
  UNIQUE (theme_id, position)
) STRICT;

CREATE TABLE heatmap_theme_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision  INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;
INSERT INTO heatmap_theme_revision (singleton, revision) VALUES (1, 0);

CREATE TABLE sync_documents_with_themes (
  kind           TEXT    NOT NULL CHECK (kind IN ('watchlists', 'screens', 'ui_state', 'layout', 'drawing', 'heatmap_themes')),
  id             TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  revision       INTEGER NOT NULL CHECK (revision >= 0),
  acked_revision INTEGER CHECK (acked_revision IS NULL OR acked_revision >= 0),
  deleted        INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (kind, id)
) STRICT;
INSERT INTO sync_documents_with_themes (kind, id, revision, acked_revision, deleted) SELECT kind, id, revision, acked_revision, deleted FROM sync_documents;
DROP TABLE sync_documents;
ALTER TABLE sync_documents_with_themes RENAME TO sync_documents;
INSERT INTO sync_documents (kind, id, revision) VALUES ('heatmap_themes', 'main', 0);
