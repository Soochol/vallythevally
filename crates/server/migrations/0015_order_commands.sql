CREATE TABLE order_commands (
  command_id      TEXT    PRIMARY KEY CHECK (length(command_id) BETWEEN 8 AND 80),
  account_ref     TEXT    NOT NULL CHECK (length(account_ref) > 0),
  fingerprint     TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('buy', 'sell', 'modify', 'cancel')),
  code            TEXT,
  venue           TEXT    CHECK (venue IN ('combined', 'krx', 'nxt')),
  quantity        INTEGER CHECK (quantity IS NULL OR quantity > 0),
  price           INTEGER CHECK (price IS NULL OR price > 0),
  target_order_no TEXT,
  state           TEXT    NOT NULL CHECK (state IN ('prepared', 'sending', 'accepted', 'rejected', 'unknown')),
  reason          TEXT,
  order_no        TEXT,
  reconciled      INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX order_commands_by_account ON order_commands (account_ref, state, created_at);
