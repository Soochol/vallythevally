# Sources — TradingView shapes, annotations, measures

All fetched 2026-11-09. Help Center pages were fetched with curl and HTML-stripped. Charting Library docs pages returned an encoded body to curl, so they were read through WebFetch (values as reported by its extractor). The fetched text is not kept in this public repository; follow the URLs below. `tools.md` restates it in our own words.

| Ref | URL | What it gave |
|---|---|---|
| S0 | https://www.tradingview.com/support/folders/43000547459-how-to-use-various-drawing-tools | Index of all per-tool Help Center articles and their URLs |
| S1 | https://www.tradingview.com/support/solutions/43000516984-rectangle-drawing-tool/ | Rectangle: Shift = square; Style/Text/Coordinates/Visibility fields; on-chart text edit; alert |
| S2 | https://www.tradingview.com/support/solutions/43000516988-ellipse-drawing-tool/ | Ellipse: Border, Background, Visibility; Shift = circle |
| S3 | https://www.tradingview.com/support/solutions/43000518134-arrow-drawing-tool/ | Arrow: Line ends, Middle point, Price labels, Stats list, Text, Coordinates (Price 1/2), alert |
| S4 | https://www.tradingview.com/support/solutions/43000791736-arrow-marker-drawing-tool/ | Arrow marker: click / drag / click placement, text signature |
| S5 | https://www.tradingview.com/support/solutions/43000518087-arrow-marks-drawing-tools/ | Arrow mark up/down: green/red default, fixed size, Text/Coordinates/Visibility |
| S6 | https://www.tradingview.com/support/solutions/43000791739-path-drawing-tool/ | Path: unlimited points, click to add, finish by double-click or Esc |
| S7 | https://www.tradingview.com/support/solutions/43000516987-brush-drawing-tool/ | Brush: freehand; Line, Background, Visibility |
| S8 | https://www.tradingview.com/support/solutions/43000516983-text-drawing-tool/ | Text: attached to a chart point; Text tab fields (General, Text Box, Background, Border, Text Wrap) |
| S9 | https://www.tradingview.com/support/solutions/43000516978-callout-drawing-tool/ | Callout: two points (point + container); Text and Coordinates fields |
| S10 | https://www.tradingview.com/support/solutions/43000518083-price-label-drawing-tool/ | Price label: text box with price + point; Style fields |
| S11 | https://www.tradingview.com/support/solutions/43000516996-date-and-price-range-drawing-tools/ | Price range / Date range / Date and price range: placement, Style, Info (Stats list), Text, Coordinates |
| S12 | https://www.tradingview.com/support/solutions/43000692906-how-to-add-text-to-range-tools/ | Text tab exists on all three range tools |
| S13 | https://www.tradingview.com/support/solutions/43000517002-long-position-drawing-tool/ | Long position: Inputs (Account size, Lot size, Risk, Entry, Leverage, Profit/Stop level, Ticks/Price, QTY precision), Style, Visibility |
| S14 | https://www.tradingview.com/support/solutions/43000516992-short-position-drawing-tool/ | Short position: same as long; leverage note differs |
| S15 | https://www.tradingview.com/support/solutions/43000475660-how-to-use-long-and-short-position-drawing-tools/ | Formulas: qty, balances, TP/SL offsets, R:R, PnL, open/closed PnL; compact mode; alerts |
| S16 | https://www.tradingview.com/support/solutions/43000744866-how-to-reverse-a-position-drawn-on-a-chart-with-the-long-or-short-position-tool/ | Reverse in context menu / floating panel flips levels around entry |
| S17 | https://www.tradingview.com/support/solutions/43000703396-drawing-tools-available-on-tradingview/ | Toolbar grouping (Geometric shapes, Annotation, Measurers); magnets, keep drawing, lock |
| S18 | https://www.tradingview.com/support/solutions/43000516986-polyline-drawing-tool/ | Polyline (contrast to Path): closes on first point; double-click / right-click / Esc leaves it open |
| S19 | Charting Library per-tool override interface pages (latest), one each: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.RectangleLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.EllipseLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ArrowLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ArrowmarkerLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ArrowmarkupLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ArrowmarkdownLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.PathLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.BrushLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.TextLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.CalloutLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.PricelabelLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.DaterangeLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.DateandpricerangeLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.RiskrewardlongLineToolOverrides; https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.RiskrewardshortLineToolOverrides | Default property values per tool |
| S20 | https://www.tradingview.com/charting-library-docs/v26/customization/overrides/Drawings-Overrides | v26 defaults incl. linetoolpricerange (only source for price-range defaults; older than latest) |
| S21 | https://www.tradingview.com/charting-library-docs/latest/api/modules/Charting_Library | SupportedLineTools identifiers |
| S22 | https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/drawings-api | createShape (1 point) vs createMultipointShape; no per-shape point counts |
| S23 | https://www.tradingview.com/charting-library-docs/latest/getting_started/Shortcuts | Drawing shortcuts (Alt+Shift+R, Shift modifiers, Ctrl+drag clone, arrows move) |
| S24 | https://www.tradingview.com/blog/en/new-shortcuts-rectangle-shortcuts-list-42318/ | Alt+Shift+R / ⌥⇧R selects Rectangle; Ctrl+/ shortcut list |
| S25 | https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/Drawings-List | Display names and toolbar categories |

Failed / not useful:
- https://www.tradingview.com/support/solutions/43000517005 (old "Date Range" article) → "Page not found".
- .../Charting_Library.PricerangeLineToolOverrides and .../PriceRangeLineToolOverrides (latest) → HTTP 404.
- https://www.tradingview.com/charting-library-docs/latest/customization/overrides/Drawings-Overrides → only horzline/icon/emoji examples.
- https://www.tradingview.com/charting-library-docs/v28/customization/overrides/Drawings-Overrides → no per-tool blocks.
- Search for official selection-handle documentation (rectangle corner/mid-edge handles) → nothing official found; only NinjaTrader forum threads (not used).
