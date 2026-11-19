UPDATE screens
SET list = (
      SELECT json_group_array(
               CASE WHEN CASE WHEN screen.type = 'object'
                              THEN json_type(screen.value, '$.exclude') IN ('null', 'array')
                                   AND EXISTS (SELECT 1 FROM json_each(screen.value, '$.exclude') WHERE type = 'null')
                              ELSE 0 END
                    THEN json(json_set(
                           screen.value,
                           '$.exclude', json((
                             SELECT json_group_array(kept.item ORDER BY kept.position)
                             FROM (
                               SELECT existing.value AS item, existing.key AS position
                               FROM json_each(CASE WHEN json_type(screen.value, '$.exclude') = 'array' THEN screen.value -> '$.exclude' ELSE '[]' END) AS existing
                               UNION ALL
                               SELECT added.value, 1000 + added.key
                               FROM json_each('["etn","infrastructure","mutual_fund"]') AS added
                               WHERE added.value NOT IN (
                                 SELECT present.value FROM json_each(CASE WHEN json_type(screen.value, '$.exclude') = 'array' THEN screen.value -> '$.exclude' ELSE '[]' END) AS present
                                 WHERE present.value IS NOT NULL
                               )
                             ) AS kept
                           ))
                         ))
                    ELSE json(screens.list -> ('$[' || screen.key || ']'))
               END ORDER BY screen.key)
      FROM json_each(screens.list) AS screen
    ),
    revision = CASE WHEN revision < 9223372036854775807 THEN revision + 1 ELSE revision END
WHERE singleton = 1
  AND EXISTS (
    SELECT 1 FROM json_each(screens.list) AS screen
    WHERE CASE WHEN screen.type = 'object'
               THEN json_type(screen.value, '$.exclude') IN ('null', 'array')
                    AND EXISTS (SELECT 1 FROM json_each(screen.value, '$.exclude') WHERE type = 'null')
               ELSE 0 END
  );
