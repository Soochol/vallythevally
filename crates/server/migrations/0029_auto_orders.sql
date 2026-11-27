CREATE TABLE IF NOT EXISTS auto_order_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    master_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO auto_order_settings (id, master_enabled) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS auto_order_rules (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    account_ref TEXT NOT NULL DEFAULT '',
    entry_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    remaining_quantity INTEGER NOT NULL,
    stop_loss_price INTEGER NOT NULL,
    take_profit_1_price INTEGER,
    take_profit_2_price INTEGER NOT NULL,
    tp1_ratio INTEGER NOT NULL DEFAULT 50,
    tp1_done INTEGER NOT NULL DEFAULT 0,
    breakeven_on_tp1 INTEGER NOT NULL DEFAULT 1,
    trailing_enabled INTEGER NOT NULL DEFAULT 0,
    trailing_pct REAL NOT NULL DEFAULT 2.0,
    high_water_mark INTEGER NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'market',
    tick_offset INTEGER NOT NULL DEFAULT 2,
    state TEXT NOT NULL DEFAULT 'watching',
    command_id TEXT,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auto_order_rules_symbol ON auto_order_rules(symbol);

CREATE TABLE IF NOT EXISTS auto_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auto_order_events_created ON auto_order_events(created_at DESC);
