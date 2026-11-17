CREATE TABLE setup_accounts (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE setup_documents (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('watchlists', 'screens', 'ui_state', 'layout', 'drawing')),
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    body TEXT,
    size INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind, id),
    CHECK ((deleted = 1) = (body IS NULL))
) STRICT;

CREATE UNIQUE INDEX setup_documents_seq ON setup_documents(account_id, seq);
