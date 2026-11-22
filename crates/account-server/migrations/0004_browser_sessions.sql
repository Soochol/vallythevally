CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE pending_logins_next (
    idp_state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    browser_hash BLOB NOT NULL,
    nonce TEXT NOT NULL,
    flow TEXT NOT NULL CHECK (flow IN ('connector', 'browser')),
    connector_port INTEGER,
    connector_state TEXT,
    code_challenge TEXT,
    expires_at INTEGER NOT NULL,
    CHECK (
        (flow = 'connector' AND connector_port IS NOT NULL AND connector_state IS NOT NULL AND code_challenge IS NOT NULL)
        OR (flow = 'browser' AND connector_port IS NULL AND connector_state IS NULL AND code_challenge IS NULL)
    )
) STRICT;

INSERT INTO pending_logins_next (idp_state, provider, browser_hash, nonce, flow, connector_port, connector_state, code_challenge, expires_at)
SELECT idp_state, provider, browser_hash, nonce, 'connector', connector_port, connector_state, code_challenge, expires_at FROM pending_logins;

DROP TABLE pending_logins;
ALTER TABLE pending_logins_next RENAME TO pending_logins;
