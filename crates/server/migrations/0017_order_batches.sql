CREATE TABLE order_batches (
  batch_id    TEXT    PRIMARY KEY CHECK (length(batch_id) BETWEEN 8 AND 64),
  account_ref TEXT    NOT NULL CHECK (length(account_ref) > 0),
  fingerprint TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

ALTER TABLE order_commands ADD COLUMN batch_id TEXT REFERENCES order_batches (batch_id);

CREATE INDEX order_commands_by_batch ON order_commands (batch_id);
