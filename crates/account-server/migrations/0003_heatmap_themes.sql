CREATE TABLE setup_documents_with_themes (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('watchlists', 'screens', 'ui_state', 'layout', 'drawing', 'heatmap_themes')),
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    body TEXT,
    size INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind, id),
    CHECK ((deleted = 1) = (body IS NULL))
) STRICT;
INSERT INTO setup_documents_with_themes (account_id, kind, id, revision, deleted, body, size, seq) SELECT account_id, kind, id, revision, deleted, body, size, seq FROM setup_documents;
DROP TABLE setup_documents;
ALTER TABLE setup_documents_with_themes RENAME TO setup_documents;
CREATE UNIQUE INDEX setup_documents_seq ON setup_documents(account_id, seq);
