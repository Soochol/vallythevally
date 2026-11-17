CREATE TABLE local_owner (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  account_id TEXT    NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128)
) STRICT;
