ALTER TABLE setup_documents ADD COLUMN born INTEGER NOT NULL DEFAULT 0;
UPDATE setup_documents SET born = seq;

CREATE INDEX setup_drawings_by_symbol ON setup_documents (account_id, json_extract(body, '$.symbol'), json_extract(body, '$.z'), id) WHERE kind = 'drawing' AND deleted = 0;
CREATE INDEX setup_layouts_by_name ON setup_documents (account_id, json_extract(body, '$.name')) WHERE kind = 'layout' AND deleted = 0;
