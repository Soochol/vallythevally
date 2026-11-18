CREATE TABLE kiwoom_environment (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  environment TEXT    NOT NULL CHECK (environment IN ('real', 'mock'))
) STRICT;
