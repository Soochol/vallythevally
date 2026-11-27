CREATE TABLE IF NOT EXISTS trading_execution_days (
    account_ref TEXT NOT NULL,
    day TEXT NOT NULL,
    finalized INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (account_ref, day)
);

CREATE TABLE IF NOT EXISTS trading_executions (
    account_ref TEXT NOT NULL,
    day TEXT NOT NULL,
    seq INTEGER NOT NULL,
    order_no TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price INTEGER NOT NULL,
    time TEXT NOT NULL,
    venue TEXT NOT NULL,
    PRIMARY KEY (account_ref, day, seq)
);

CREATE INDEX IF NOT EXISTS idx_trading_executions_account_day
    ON trading_executions(account_ref, day);
