ALTER TABLE layout_windows ADD COLUMN broker_view TEXT CHECK (broker_view IS NULL OR (kind = 'brokers' AND broker_view IN ('board', 'list')));
ALTER TABLE layout_windows ADD COLUMN broker_cards TEXT CHECK (broker_cards IS NULL OR (kind = 'brokers' AND broker_cards IN ('bars', 'both', 'numbers')));
