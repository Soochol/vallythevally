# Sources: TradingView lines + Fibonacci tools

All fetched on 2026-11-09. Help-center and Charting Library pages were fetched with curl. The fetched text is not kept in this public repository; follow the URLs below. `tools.md` restates what each page says in our own words.

Source tiers:
- **S#**: TradingView Help Center (tradingview.com/support) quoted text. Primary.
- **CL#**: TradingView Charting Library / Advanced Charts docs. Primary, but these are the **library's documented defaults**. They may differ from the tradingview.com web app defaults.
- **IMG#**: my observation of a screenshot embedded in an S# article. See `screenshots.md`. Weaker than text.
- **X#**: secondary sources (TradingView-authored ideas or education pages, read through a WebFetch summary, not saved verbatim). Not used for any cell in `tools.md`.

| ID | URL | What it gave |
|---|---|---|
| S1 | https://www.tradingview.com/support/solutions/43000518095-trendline-drawing-tool/ | Trendline Style/Text/Coordinates/Visibility fields, arrow ends, middle point, stats, Shift for 45° |
| S2 | https://www.tradingview.com/support/solutions/43000518113-ray-drawing-tool/ | Ray: point 1 = origin, point 2 = direction; same fields as trendline |
| S3 | https://www.tradingview.com/support/solutions/43000518131-extended-line-drawing-tool/ | Extended line: extends both ways; arrow ends visible only when extending is switched off |
| S4 | https://www.tradingview.com/support/solutions/43000518124-horizontal-line-drawing-tool/ | Horizontal line: Alt+H, price label, price-only coordinates |
| S5 | https://www.tradingview.com/support/solutions/43000518121-horizontal-ray-drawing-tool/ | Horizontal ray: extends left to right from origin; price + bar coordinates |
| S6 | https://www.tradingview.com/support/solutions/43000518093-vertical-line-drawing-tool/ | Vertical line: Alt+V, Extend through indicator panes, time label, text orientation, bar-only coordinates |
| S7 | https://www.tradingview.com/support/solutions/43000518117-parallel-channel-drawing-tool/ | Channel levels, extend left/right, background, coordinates #1/#2/Price offset |
| S8 | https://www.tradingview.com/support/solutions/43000518158-fibonacci-retracement-drawing-tool/ | Fib retracement: 24 levels, style fields, reverse, prices/levels/labels, log scale, alerts |
| S9 | https://www.tradingview.com/support/solutions/43000518137-trend-based-fib-extension-drawing-tool/ | Trend-based fib ext: 3 points and their meaning, same style fields as retracement, Price 1/2/3 |
| S10 | https://www.tradingview.com/support/solutions/43000542398-how-to-extend-fibonacci-retracement-lines/ | "Extend lines left" / "Extend lines right" checkboxes |
| S11 | https://www.tradingview.com/support/solutions/43000710744-how-to-add-text-to-channel-drawing-tools/ | Parallel channel Text tab; open settings by double-click or gear |
| S12 | https://www.tradingview.com/support/solutions/43000537268-how-to-draw-lines-at-a-45-angle/ | Hold Shift while drawing Trend Line or Channel snaps to multiples of 45° |
| S13 | https://www.tradingview.com/support/solutions/43000538248-how-to-drag-drawings-horizontally-vertically/ | Shift+drag constrains the move; arrow keys move 1 bar / 1 mintick |
| S14 | https://www.tradingview.com/support/solutions/43000722509-magnet-mode/ | Ctrl/Cmd toggles magnet temporarily while drawing or editing |
| S15 | https://www.tradingview.com/support/solutions/43000537251-how-to-clone-drawings/ | Ctrl/Cmd+drag clones |
| S16 | https://www.tradingview.com/support/solutions/43000543443-how-to-remove-specific-fibonacci-retracement-levels/ | Eraser + Ctrl/Cmd click removes one fib level |
| S17 | https://www.tradingview.com/support/solutions/43000703396-drawing-tools-available-on-tradingview/ | Tool groups: Trend tools, Channels, Fibonacci |
| S18 | https://www.tradingview.com/support/solutions/43000473103-i-can-t-find-drawing-tools-fib-retracement-trend-line-or-other/ | Tools live in the left panel by subgroup |
| S19 | https://www.tradingview.com/support/folders/43000547459-how-to-use-various-drawing-tools/ | Index of per-tool article URLs |
| S20 | https://www.tradingview.com/support/folders/43000561752-shortcuts-and-tips/ | Index of S10, S12–S16 |
| CL1 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.TrendlineLineToolOverrides/ | `linetooltrendline.*` defaults |
| CL2 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.RayLineToolOverrides/ | `linetoolray.*` defaults (extendRight true) |
| CL3 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ExtendedLineToolOverrides/ | `linetoolextended.*` defaults (extendLeft/Right true) |
| CL4 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.HorzlineLineToolOverrides/ | `linetoolhorzline.*` defaults |
| CL5 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.HorzrayLineToolOverrides/ | `linetoolhorzray.*` defaults |
| CL6 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.VertlineLineToolOverrides/ | `linetoolvertline.*` defaults (extendLine true) |
| CL7 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ParallelchannelLineToolOverrides/ | `linetoolparallelchannel.*` defaults (midline, fill) |
| CL8 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.FibretracementLineToolOverrides/ | 24 level coeff/color/visible defaults + style defaults |
| CL9 | https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.TrendbasedfibextensionLineToolOverrides/ | Same keys and values as CL8 (diffed: identical apart from prefix) |
| CL10 | https://www.tradingview.com/charting-library-docs/latest/configuration/Shortcuts/ | Alt+T/H/V/C/F, Shift 45°, Ctrl magnet, Ctrl+drag clone, arrows move |
| CL11 | https://www.tradingview.com/charting-library-docs/latest/api/enums/Charting_Library.LineStyle/ | LineStyle: Solid=0, Dotted=1, Dashed=2 |
| CL12 | https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/drawings-api/ | createShape = one-point drawings (vertical/horizontal lines); createMultipointShape; "Wrong points count" |
| CL13 | https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/Drawings-List/ | Library drawing list (Trend tools, Gann and Fibonacci tools) |
| CL14 | https://www.tradingview.com/charting-library-docs/latest/api/ | Index used to find exact interface names |
| CL15 | https://www.tradingview.com/charting-library-docs/latest/customization/overrides/Drawings-Overrides/ | How overrides apply; no defaults table |
| — | https://www.tradingview.com/charting-library-docs/latest/api/enums/Charting_Library.LineEnd/ | 404. LineEnd enum values not found |
| IMG1–IMG8 | freshdesk image URLs listed in `screenshots.md` | Handles, dialog tabs, level grid order, rubber-band preview |
| X1 | https://www.tradingview.com/chart/TSLA/qw8dRAeQ-TradingView-Masterclass-How-To-Use-Drawing-Tools/ | Secondary. Repeats Alt+T/F/H/V and ⌥ on Mac |
| X2 | https://www.tradingview.com/chart/ETHUSD/iZfP6Aqb-Creating-Lines-with-Shortcuts/ | Secondary. Alt+H/V/C |
| X3 | https://www.tradingview.com/education/parallelchannels/ | Nothing on how to draw a channel |
