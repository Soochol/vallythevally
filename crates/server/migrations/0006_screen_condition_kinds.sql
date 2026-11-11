UPDATE screens
SET list = (
      SELECT json_group_array(json(json_set(
               json_remove(screen.value, '$.period'),
               '$.markets', json('[]'),
               '$.conditions', json((
                 SELECT json_group_array(json(json_set(line.value, '$.kind', 'new_high', '$.period', json_extract(screen.value, '$.period'))) ORDER BY line.key)
                 FROM json_each(screen.value, '$.conditions') AS line
               ))
             )) ORDER BY screen.key)
      FROM json_each(screens.list) AS screen
    ),
    revision = revision + 1
WHERE singleton = 1 AND json_array_length(list) > 0;
