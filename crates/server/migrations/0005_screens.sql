CREATE TABLE screens (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  list      TEXT    NOT NULL CHECK (json_valid(list) AND json_type(list) = 'array'),
  revision  INTEGER NOT NULL
) STRICT;

INSERT INTO screens (singleton, list, revision) VALUES (1, '[]', 0);
