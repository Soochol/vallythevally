DELETE FROM layout_windows WHERE kind = 'objects';

UPDATE drawings SET hidden = 0, updated_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE hidden = 1;
