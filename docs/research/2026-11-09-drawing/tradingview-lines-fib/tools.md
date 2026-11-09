# TradingView line and Fibonacci tools: behavior spec from official sources

Refs point to `sources.md`. S = Help Center text, CL = Charting Library documented defaults, IMG = my reading of a help-center screenshot (see `screenshots.md`).
"not found" means no fetched source states it.

Notes for every table:
- **CL defaults are the Charting Library's documented defaults.** They may not equal the tradingview.com web app defaults. Where an IMG screenshot agrees, the row says so.
- `linestyle` numbers: 0 = Solid, 1 = Dotted, 2 = Dashed [CL11].
- `leftEnd`/`rightEnd` 0 is the default. Its meaning (normal end) and the arrow value are inferred, because the LineEnd enum page returned 404.
- Anchor counts come from each tool's Coordinates tab fields [S#]. CL12 confirms the method: "You can check the number of required points in the Settings dialog", and one-point drawings such as "vertical or horizontal lines" use `createShape`.
- **Placement gesture (click-click vs press-drag): not found for any of these nine tools.** S2 says "place the initial point … and the second point". IMG1 shows a rubber-band preview from point 1 to the cursor, but a still image cannot show whether the button is held.
- Common modifiers [CL10][S12–S15]: Shift while drawing a Trend line or Channel snaps to multiples of 45°. Shift+drag moves a drawing strictly horizontally or vertically. Arrow keys move a selected drawing 1 bar or 1 mintick. Holding Ctrl/⌘ toggles magnet temporarily while drawing or moving a point. Ctrl/⌘+drag clones a drawing.
- Settings open by double-click on the object or the gear button [S11]. All nine tools support "Add alert" from the floating toolbar clock icon or the right-click menu [S1–S9].
- Visibility tab (all tools): "switch displaying … on charts of different timeframes" [S1–S8]. For the fibs: "For any timeframe, you can select either to show it, or to hide" [S8][S9].

## Trend Line
| Field | Value | Ref |
|---|---|---|
| Anchors | 2 (Coordinates: Price 1, Price 2, each as bar number + price) | S1 |
| Handles when selected | Hollow circle at each end. A smaller circle at the mid-point when "Middle point" is ON (it was ON in the screenshot). Mid handle with the option OFF: not found | IMG1, IMG2 |
| While drawing | Rubber-band line from point 1 to cursor, axis highlights | IMG1 |
| Default style | color #2962FF, width 2, linestyle 0 (solid), extendLeft false, extendRight false, leftEnd/rightEnd 0, showMiddlePoint false, showPriceLabels false, all stats false, statsPosition 2, alwaysShowStats false, text: fontsize 14, color #2962FF, bold/italic false, horzLabelsAlign center, vertLabelsAlign bottom | CL1 |
| Style tab | Line (color, opacity, thickness, style, left-end and right-end arrow dropdowns), Extend dropdown ("Don't extend" shown), Middle point, Price labels, Stats (Price range, Percent change, Change in pips, Bars range, Date/time range, Distance, Angle), Stats position, Always show stats | S1, IMG2 |
| Text tab | Text checkbox + text box, color, font size, bold, italic, Text alignment. Text can be edited directly on the chart | S1 |
| Coordinates / Visibility | Price 1, Price 2 (bar + price) / per-timeframe | S1 |
| Shortcut | Alt+T (⌥T on Mac). Shift while drawing = 45° | CL10, S1, S12 |

## Ray
| Field | Value | Ref |
|---|---|---|
| Anchors | 2. "The first point … defines the origin, and the second point defines the direction" and the line extends that way indefinitely | S2 |
| Handles | not found (presumably as Trend Line, unverified) | — |
| Default style | Same as Trend Line except extendRight **true** (extendLeft false). #2962FF, width 2, solid, text fontsize 14 | CL2 |
| Style / Text tabs | Same field set as Trend Line (Line + arrow ends, Middle point, Price labels, Stats…, Always show stats; Text + alignment) | S2 |
| Coordinates | Price 1, Price 2 (bar + price) | S2 |
| Shortcut | not found | — |

## Extended Line
| Field | Value | Ref |
|---|---|---|
| Anchors | 2 (Price 1, Price 2). "extends indefinitely in any direction" | S3 |
| Handles | not found | — |
| Default style | Trend Line defaults with extendLeft **true**, extendRight **true** | CL3 |
| Style | As Trend Line. "To make the line's end visible, switch off its extending by slider" (arrow ends show only when extension is off) | S3 |
| Text / Coordinates | As Trend Line / Price 1, Price 2 | S3 |
| Shortcut | not found | — |

## Horizontal Line
| Field | Value | Ref |
|---|---|---|
| Anchors | 1, price only (Coordinates: price) | S4, CL12 |
| Placement | "select the point and press Alt+H" | S4 |
| Handles | not found | — |
| Default style | color #2962FF, width 2, solid, showPrice **true**, text fontsize **12**, color #2962FF, horzLabelsAlign center, vertLabelsAlign middle | CL4 |
| Style tab | Line (color, opacity, thickness, style), Price label | S4 |
| Text tab | Text + color/opacity, font size, bold, italic, Text alignment dropdowns. Editable on the chart | S4 |
| Shortcut | Alt+H / ⌥H | S4, CL10 |

## Horizontal Ray
| Field | Value | Ref |
|---|---|---|
| Anchors | 1 (Coordinates: price + bar number of the initial point). Extends "from left to right indefinitely" | S5 |
| Handles | not found | — |
| Default style | #2962FF, width 2, solid, showPrice true, fontsize 12, horzLabelsAlign center, vertLabelsAlign **top** | CL5 |
| Style / Text | Line (color, opacity, thickness, style), Price label / as Horizontal Line | S5 |
| Shortcut | not found | — |

## Vertical Line
| Field | Value | Ref |
|---|---|---|
| Anchors | 1, time only (Coordinates: bar number) | S6, CL12 |
| Placement | "hover the point … and press Alt + V" | S6 |
| Handles | not found | — |
| Default style | #2962FF, width 2, solid, extendLine **true**, showTime **true**, fontsize 14, textOrientation **vertical**, horzLabelsAlign center, vertLabelsAlign middle | CL6 |
| Style tab | Line (color, opacity, thickness, style), Extend ("Extends the vertical line through the Indicator panes"), Time Label | S6 |
| Text tab | Text, color, font size, bold, italic, Text Alignment, Text Orientation | S6 |
| Shortcut | Alt+V / ⌥V | S6, CL10 |

## Parallel Channel
| Field | Value | Ref |
|---|---|---|
| Anchors | 3 values: #1 and #2 (bar + price) are the two points of level 0. "Price offset" places level 1 relative to level 0 | S7 |
| Handles | 3 hollow circles seen (two on one line, one at the right end of the other line). The dialog covers the rest. No "width handle" is named in any text | IMG4 |
| Default style | linecolor #2962FF, width 2, solid. showMidline **true**, midline #2962FF width 1 style 2 (dashed). fillBackground true, backgroundColor rgba(41,98,255,0.2), transparency 20. extendLeft/Right false. labelVisible false, label fontsize 14, color #2962FF, horz left, vert bottom | CL7 |
| Default look | Two solid lines, dashed midline, translucent blue fill (matches CL7) | IMG3 |
| Style tab | Channel's levels (color, opacity, thickness, style; checkboxes for additional levels; custom ratio), Extend Left Line, Extend Right Line, Background + color/opacity | S7 |
| Level grid (UI) | -0.25 ☐, 0 (fixed), 0.25 ☐, 0.5 ☑ dashed, 0.75 ☐, 1 (fixed), 1.25 ☐. Extend is a dropdown ("Don't extend") in the current UI | IMG4 |
| Text tab | Text box, position and alignment relative to the lines | S7, S11 |
| Shortcut | not found. Shift while drawing = 45° | S12, CL10 |

## Fib Retracement
| Field | Value | Ref |
|---|---|---|
| Anchors | 2 (Price 1, Price 2). Level 0% and 100% "are defined by the two extremes of the trend line". 24 levels max. Values 0..1 internal, >1 external, <0 extensions | S8 |
| Handles | 2 hollow circles at the anchors | IMG6 |
| Default levels (coeff color visible) | 0 #808080 ✓ · 0.236 #F23645 ✓ · 0.382 #FF9800 ✓ · 0.5 #4caf50 ✓ · 0.618 #089981 ✓ · 0.786 #00bcd4 ✓ · 1 #808080 ✓ · 1.618 #2962FF ✓ · 2.618 #F23645 ✓ · 3.618 #9c27b0 ✓ · 4.236 #e91e63 ✓ · hidden: 1.272 #FF9800, 1.414 #F23645, 2.272 #FF9800, 2.414 #4caf50, 2 #089981, 3 #00bcd4, 3.272 #808080, 3.414 #2962FF, 4 #F23645, 4.272 #9c27b0, 4.414 #e91e63, 4.618 #FF9800, 4.764 #089981 | CL8 |
| Other defaults | trendline visible, #808080, width 2, style 2 (dashed). levelsStyle width 2, solid. extendLines false, extendLinesLeft false. reverse false. fillBackground true, transparency 80. showPrices true, showCoeffs true, coeffsAsPercents false, showText true. labelFontSize 12. horzLabelsAlign left, vertLabelsAlign middle, horzTextAlign center, vertTextAlign middle. fibLevelsBasedOnLogScale false | CL8 |
| Label look | `coeff (price)` at the left end of each level, in the level color. Fill between levels in level colors | IMG5 |
| Style tab | Trend Line (toggle, color, opacity, thickness, style), Levels Line (thickness, style), Extend Lines Left/Right, Additional Levels (checkbox, custom ratio, color+opacity), Use one color, Background (visibility, opacity), Reverse ("reflects it vertically"), Prices, Levels (absolute or percent value), Labels (position along level), Text (position), Font size, Fib levels based on log scale (only available when the chart's log scale is on) | S8 |
| Extend UI | Text says "Extend lines left" / "Extend lines right" checkboxes [S10]. Current screenshot shows an "Extend" dropdown [IMG6]. CL names are `extendLines` + `extendLinesLeft`. That `extendLines` means "right" is an inference | S10, IMG6, CL8 |
| Tabs | Style, Coordinates, Visibility (no Text tab). Per-level text is typed directly on the chart | IMG6, S8 |
| Remove one level | Eraser + Ctrl/⌘ click on the level | S16 |
| Shortcut | Alt+F / ⌥F | CL10, IMG7 |

## Trend-Based Fib Extension
| Field | Value | Ref |
|---|---|---|
| Anchors | 3: start of the move, end of the move, end of the retracement against it (Price 1/2/3) | S9 |
| Handles | 3 hollow circles (one per anchor), dashed grey trend line through them | IMG8 |
| Default levels | Identical to Fib Retracement (all keys and values diffed equal) | CL9 vs CL8 |
| UI confirms defaults | Level grid order 0, .236, .382, .5, .618, .786, 1, 1.618, 2.618, 3.618, 4.236 checked, the rest unchecked. Colors match CL | IMG8 |
| Other defaults | Same as Fib Retracement (trendline dashed #808080, fill transparency 80, labels left, …) | CL9 |
| Style tab | Same field list as Fib Retracement, incl. Reverse, Use one color, log scale option | S9 |
| Tabs | Style, Coordinates, Visibility | IMG8 |
| Shortcut | not found. No shortcut is shown in the toolbar menu | IMG7 |

## Not verified / not found
- Click-click vs press-drag placement, for all tools.
- Handles for Ray, Extended, Horizontal line/ray, Vertical line. The trend-line mid handle when Middle point is OFF.
- Which anchor maps to level 0 vs 1 in Fib Retracement, and the exact Fib Extension projection formula. The screenshots don't settle drawing order.
- LineEnd enum values (arrow) and statsPosition enum meaning.
- Whether CL defaults equal tradingview.com web defaults. IMG3, IMG7, and IMG8 agree with them.
- Shortcuts for Ray, Extended line, Horizontal ray, Parallel channel, Trend-based fib extension.
