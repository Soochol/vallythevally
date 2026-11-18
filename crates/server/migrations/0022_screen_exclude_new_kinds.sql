UPDATE screens
SET list = (
      SELECT json_group_array(json(json_set(
               screen.value,
               '$.exclude', json((
                 SELECT json_group_array(kept.item ORDER BY kept.position)
                 FROM (
                   SELECT existing.value AS item, existing.key AS position
                   FROM json_each(screen.value, '$.exclude') AS existing
                   UNION ALL
                   SELECT added.value, 1000 + added.key
                   FROM json_each('["etn","infrastructure","mutual_fund"]') AS added
                   WHERE added.value NOT IN (SELECT value FROM json_each(screen.value, '$.exclude'))
                 ) AS kept
               ))
             )) ORDER BY screen.key)
      FROM json_each(screens.list) AS screen
    ),
    revision = CASE WHEN revision < 9223372036854775807 THEN revision + 1 ELSE revision END
WHERE singleton = 1 AND json_array_length(list) > 0;
