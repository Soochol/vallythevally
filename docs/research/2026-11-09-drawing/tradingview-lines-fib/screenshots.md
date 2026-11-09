# Screenshot observations (IMG1–IMG8)

These are **my readings of images** embedded in the official help-center articles, not page text.
Images were downloaded on 2026-11-09 and viewed (PNG downscaled to 1600px; the GIF sampled as 12 frames).
Treat each line as observation, weaker than quoted text.

## IMG1 — Trendline article, animated GIF (271 frames)
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43525290437/original/o2tnikGDgCAqgvlxKB4qsdiqy5JMkCJrJQ.gif?1732448990
- While drawing, a line runs from the first fixed point to the cursor (rubber-band preview), with a crosshair cursor, dashed crosshair guide lines, and the cursor's price and date highlighted on the axes.
- After placement, each of the two end points shows a small hollow circle (handle), and a floating toolbar (color, "2px", line style, ...) appears at the bottom of the chart.
- In one frame the magnet icon in the left toolbar is highlighted, and the first point sits on a bar's low.
- The frames do not show whether the mouse button is held down between points (click-click vs press-drag cannot be determined).

## IMG2 — Trendline article, settings dialog
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43581451214/original/XH3N-739D44IWi2ZgUPjwztBrBBz3ABeJw.png?1758210818
- Dialog title "Trend Line" (pencil icon to rename). Tabs: Style | Text | Coordinates | Visibility. Footer: Template ▾, Cancel, Ok.
- Style rows: "Line" [color/width swatch][left-end dropdown][right-end dropdown]; "Extend" dropdown showing "Don't extend"; "Middle point" checkbox (checked in this shot); "Price labels" checkbox (checked); section "INFO": "Stats" multi-select (Price range, Percent change, Change in pips, Bars range, Date/time range, Distance, Angle); "Stats position"; "Always show ..." checkbox.
- On chart, the selected line shows: hollow circle at each end point, plus a smaller circle at the mid-point (Middle point is ON here); stats box beside it showing "32.93 (14.58%), 3,293" and "63.88°"; the two prices highlighted on the price axis and the two dates highlighted on the time axis.

## IMG3 — Parallel channel article, chart
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43581390071/original/PZ7g6RjrEO7Ra-rscY0DEzk3ZIkvcghkUg.png?1758197429
- Two solid blue parallel lines, a dashed middle line between them, semi-transparent blue fill between the outer lines.

## IMG4 — Parallel channel article, settings dialog
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43581390229/original/7bQYLWxk8liRa6AueHrHKqe6jMuM7K3b5A.png?1758197466
- Tabs: Style | Text | Coordinates | Visibility.
- Level rows: -0.25 (unchecked), 0 (no checkbox, solid), 0.25 (unchecked), 0.5 (checked, dashed), 0.75 (unchecked), 1 (no checkbox, solid), 1.25 (unchecked). Then "Extend" dropdown "Don't extend", "Background" checkbox (checked) with color swatch.
- On chart: three hollow-circle handles visible (left end of one line, right end of both lines); the dialog covers the rest. Both prices and both dates highlighted on axes.

## IMG5 — Fib retracement article, chart
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43580696326/original/8FHw0Huz1x1aeMu_twDxZYhwaB-BkqStUg.png?1757945863
- Level labels sit at the left end of each level line in the format `coeff (price)`, e.g. "0.618 (9.96)", in the level's color. Fills between levels in each level's color, semi-transparent. Grey dashed diagonal trend line between the two anchors.

## IMG6 — Fib retracement article, settings dialog (USER-MODIFIED levels; do not use for defaults)
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43580696531/original/7MTfBIMh8R9Zd0LtN-dJh1X30dXZOnb2YQ.png?1757945900
- Tabs: Style | Coordinates | Visibility (no Text tab).
- Style rows: "Trend line" checkbox + [grey swatch, dashed]; "Levels line" [solid width][style]; "Extend" dropdown "Don't extend"; then a two-column grid of level rows: checkbox, coeff input, color swatch.
- On chart: two hollow-circle handles at the two anchors; both prices and dates highlighted on axes.

## IMG7 — Trend-based fib extension article, toolbar menu + chart
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43581446650/original/59lU314hymcClzPUQ_CNUonbkCUSsmVOlw.png?1758209984
- Toolbar "FIBONACCI" group: Fib Retracement (shows "⌥ F" beside it), Trend-Based Fib Extension (no shortcut shown), Fib Channel, Fib Time Zone, ...
- Chart: visible levels 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236 with labels `coeff (price)` at the left end.

## IMG8 — Trend-based fib extension article, settings dialog
URL: https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/43581446746/original/UUD9ck5eKY7-PK-we4l7QFyK3CK2IKRsaw.png?1758210004
- Tabs: Style | Coordinates | Visibility (no Text tab).
- Level grid order: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236 (all checked), then 1.272, 1.414, 2.272, 2.414, 2, 3, 3.272, 3.414, 4, ... (unchecked). Checked/unchecked and colors match the Charting Library defaults in cl-trendbasedfibextension-overrides.md.
- On chart: three hollow-circle handles (one per anchor), dashed grey trend line through them; the three prices highlighted on the price axis.
