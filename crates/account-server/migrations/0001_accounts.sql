CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE identities (
    provider TEXT NOT NULL CHECK (provider IN ('google', 'naver')),
    subject TEXT NOT NULL,
    account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (provider, subject)
) STRICT;

CREATE TABLE pending_logins (
    idp_state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    browser_hash BLOB NOT NULL,
    nonce TEXT NOT NULL,
    connector_port INTEGER NOT NULL,
    connector_state TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_codes (
    code_hash BLOB PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE connector_tokens (
    token_hash BLOB PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
) STRICT;

CREATE INDEX connector_tokens_account ON connector_tokens(account_id);
