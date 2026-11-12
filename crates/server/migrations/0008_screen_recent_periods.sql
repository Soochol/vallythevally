UPDATE screens
SET list = (
      SELECT json_group_array(json(json_set(
               screen.value,
               '$.conditions', json((
                 SELECT json_group_array(json(
                   CASE WHEN json_type(line.value, '$.barRange') IS NOT NULL
                   THEN json_set(json_remove(line.value, '$.barRange'), '$.recentBars', json_extract(line.value, '$.barRange.end') + 1)
                   ELSE line.value END
                 ) ORDER BY line.key)
                 FROM json_each(screen.value, '$.conditions') AS line
               ))
             )) ORDER BY screen.key)
      FROM json_each(screens.list) AS screen
    ),
    revision = CASE WHEN revision < 9223372036854775807 THEN revision + 1 ELSE revision END
WHERE singleton = 1 AND EXISTS (
  SELECT 1 FROM json_each(screens.list) AS screen, json_each(screen.value, '$.conditions') AS line
  WHERE json_type(line.value, '$.barRange') IS NOT NULL
);
