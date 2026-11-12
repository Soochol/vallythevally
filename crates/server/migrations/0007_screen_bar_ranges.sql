UPDATE screens
SET list = (
      SELECT json_group_array(json(json_set(
               screen.value,
               '$.conditions', json((
                 SELECT json_group_array(json(
                   CASE WHEN json_extract(line.value, '$.kind') = 'market_cap' THEN line.value
                   ELSE json_set(json_remove(line.value, '$.m'), '$.barRange', json_object('start', 0, 'end', json_extract(line.value, '$.m') - 1)) END
                 ) ORDER BY line.key)
                 FROM json_each(screen.value, '$.conditions') AS line
               ))
             )) ORDER BY screen.key)
      FROM json_each(screens.list) AS screen
    ),
    revision = CASE WHEN revision < 9223372036854775807 THEN revision + 1 ELSE revision END
WHERE singleton = 1 AND EXISTS (
  SELECT 1 FROM json_each(screens.list) AS screen, json_each(screen.value, '$.conditions') AS line
  WHERE json_type(line.value, '$.m') IS NOT NULL
);
