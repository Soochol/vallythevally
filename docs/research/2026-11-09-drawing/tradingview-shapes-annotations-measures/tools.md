# TradingView shapes, annotations, measures — per-tool facts

Every cell cites `sources.md`. "NF" = not found in sources. Defaults come from the Charting Library "latest" overrides [S19]; the Supercharts web app is assumed but not proven to share them.

Common to all tools [S23][S24]: Alt+Shift+R selects Rectangle; Shift while dragging a Rectangle gives a square, Ellipse a circle; Drag+Shift moves a drawing horizontally or vertically; Ctrl+Drag clones it; arrow keys move the selected drawing; Ctrl while moving a point toggles magnet. Most per-tool articles name the settings tabs Style / Text / Coordinates / Visibility; Long/Short instead have Inputs / Style / Visibility and no Coordinates tab [S13]. Where a Coordinates tab is described, points are set by price + bar number.

## Rectangle (`rectangle`)
| Field | Fact |
|---|---|
| Points / placement | multipoint shape [S22]; exact point count NF (S1 says only "rectangle points"); placement gesture NF. Shift → square [S1] |
| Handles when selected | NF |
| Default style | border #9c27b0 width 2; fill on rgba(156,39,176,0.2), transparency 50; middle line off (#9c27b0, w1, style 2); text off, 14px, #9c27b0, h-align center, v-align middle; extendLeft/Right false [S19] |
| Style tab | Border (color, thickness, line type); Middle line (toggle, color, thickness, type); Background (toggle, color, opacity); Extend right; Extend left [S1] |
| Text tab | text note: color, size, font style, location; also edit on chart by clicking the center text field [S1] |
| Coordinates / Visibility | point price + bar number / per-timeframe [S1] |
| Shortcut | Alt+Shift+R (Win), ⌥⇧R (Mac) [S24][S23] |
| Other | alert from floating toolbar clock icon or right-click menu [S1] |

## Ellipse (`ellipse`)
| Field | Fact |
|---|---|
| Points / placement | NF (article silent). Shift → circle [S2][S23] |
| Handles | NF |
| Default style | border #F23645 w2; fill on rgba(242,54,69,0.2), transparency 50; text #F23645 14px [S19] |
| Style tab | Border (color, thickness); Background (toggle, color, opacity) [S2] |
| Text tab | not in article [S2]; text property exists in overrides [S19] |
| Coordinates | NF in article |
| Visibility | per-timeframe [S2] |

## Arrow (`arrow`)
| Field | Fact |
|---|---|
| Points | 2 points: "Price 1", "Price 2" [S3]; placement gesture NF |
| Handles | NF ("Middle Point" visibility toggle exists [S3]) |
| Default style | line #2962FF w2 style 0 (solid); leftEnd 0 (normal), rightEnd 1 (arrow); price labels off; all stats off; statsPosition 2; text #2962FF 14px, h center, v bottom [S19] |
| Style tab | Line (color, opacity, thickness, style, left/right end: arrow or normal); Middle Point; Price labels; Stats checkboxes: Price range, Percent change, Change in pips, Bars range, Date/time range, Distance, Angle; Stats position; Always show stats (else stats only when selected) [S3] |
| Text tab | text checkbox + box; color, font size, bold, italic; Text alignment along the line; on-chart edit [S3] |
| Coordinates / Visibility | Price 1/Price 2 bar+price / per-timeframe [S3] |
| Other | alert on series crossing the arrow [S3] |

## Arrow marker (`arrow_marker`)
| Field | Fact |
|---|---|
| Points / placement | 2: click to set the start, move the cursor to the second point (it sets the arrow direction), click again to fix it [S4] |
| Default style | background #1E53E5; text #1E53E5 16px bold [S19] |
| Other | can attach a text signature [S4]; settings tabs NF |

## Arrow mark up / down (`arrow_up`, `arrow_down`)
| Field | Fact |
|---|---|
| Points | 1 point (price + bar number) [S5] |
| Default style | up green #089981, down red #CC2F3C; size fixed, cannot change; label shown, 14px [S5][S19] |
| Style / Text tab | Style: color only. Text: note, color+opacity, font size, bold, italic [S5] |
| Coordinates / Visibility | price + bar / per-timeframe [S5] |

## Path (`path`)
| Field | Fact |
|---|---|
| Points / placement | unlimited; click to start, click to add each anchor [S6] |
| Finish | double-click the final point, or Esc [S6]. (Polyline, by contrast, closes when the last point hits the first; double-click / right-click / Esc leaves it open [S18]) |
| Default style | line #2962FF w2 solid; leftEnd 0 normal, rightEnd 1 arrow [S19] |
| Handles / tabs / shortcut | NF (article has no settings sections) |

## Brush (`brush`)
| Field | Fact |
|---|---|
| Placement | freehand, "not bound to a specific shape" [S7]; gesture detail NF |
| Default style | line #00bcd4 w2; fill off (#00bcd4, transparency 50); both ends normal; smooth 5 [S19] |
| Style tab | Line (color, thickness); Background (toggle, color, opacity) [S7] |
| Visibility | per-timeframe [S7]; Coordinates tab not mentioned |

## Text (`text`)
| Field | Fact |
|---|---|
| Points | 1 point; anchored to a chart point, scrolls with the chart (unlike anchored text) [S8] |
| Placement | "place it on the chart and enter its content"; edit later by clicking the text [S8] |
| Default style | color #2962FF 14px; background off (rgba(41,98,255,0.25), transparency 70); border off (#707070); wordWrap off, width 200; fixedSize true [S19] |
| Text tab | General (color, font size, bold, italic); Text Box; Background (toggle, color, opacity); Border (toggle, color); Text Wrap [S8] |
| Visibility | per-timeframe [S8] |

## Callout (`callout`)
| Field | Fact |
|---|---|
| Points | 2: Price 1 = the point, Price 2 = the text container [S9] |
| Placement | "set its two points on the chart and enter text"; on-chart edit [S9] |
| Default style | text #ffffff 14px; background rgba(0,151,167,0.7), transparency 50; border #0097A7 w2; wordWrap off, width 200 [S19] |
| Text tab | General (color, size, bold, italic); Text Box; Background (color, opacity); Border (color, opacity, thickness, style); Text Wrap [S9] |
| Coordinates / Visibility | bar + price for each point / per-timeframe [S9] |

## Price label (`price_label`)
| Field | Fact |
|---|---|
| Points | 1 point (price + bar number); text box always contains the price [S10] |
| Default style | background #2962FF; border #2962FF; text #ffffff 14px bold; transparency 0 [S19] |
| Style tab | Text Color (color, font size, opacity); Background (color, opacity); Border (color, opacity) [S10] |
| Coordinates / Visibility | yes / per-timeframe [S10] |

## Price range (`price_range`)
| Field | Fact |
|---|---|
| Points | 2, placed vertically [S11] |
| Shown | shaded box; label: absolute change, % change, pips (ticks) [S11] |
| Default style | latest NF (interface page 404). v26 only: linecolor rgba(21,119,96,1) w1; text white 12px; label bg rgba(41,98,255,0.9); fill rgba(41,98,255,0.2), transparency 60; border off; extendLeft/Right false [S20] |
| Style | Line; Border; Background; Extend (horizontal, infinite) [S11] |
| Info | Stats checklist: Price range, Percent change, Change in pips, Bars range, Date/time range, Volume; Label (color, opacity, size); Label background [S11]. ("options may vary slightly" by tool is stated for the Style section [S11]) |
| Text / Coords / Visibility | custom text [S11][S12]; Price 1/Price 2; per-interval [S11] |

## Date range (`date_range`)
| Field | Fact |
|---|---|
| Points | 2, placed horizontally [S11] |
| Shown | number of bars, time elapsed, optionally volume [S11] |
| Default style | line #2962FF w2; fill #2962FF, transparency 60; label bg #585858, 12px; showBarsRange/showDateTimeRange/showVolume true; extendTop/Bottom false; custom text off [S19] |
| Style | Line; Border; Background; Extend (vertical) [S11] |
| Info / Text / Coords | as Price range [S11][S12] |

## Date and price range (`date_and_price_range`)
| Field | Fact |
|---|---|
| Points | 2, placed diagonally [S11] |
| Shown | time elapsed + price movement in one label [S11]; all six stats default on (price, %, pips, bars, date/time, volume) [S19] |
| Default style | as Date range, plus border off (#2962FF w1) [S19] |
| Style / Info / Text / Coords | as above; Extend listed for Date/Price range only [S11] |

## Long position (`long_position`) / Short position (`short_position`)
| Field | Fact |
|---|---|
| Layout | entry level; green profit box and red loss box above/below; both adjustable to change R:R [S13][S14] |
| Inputs | Account Size; Lot Size; Risk (absolute or % of account); Entry Price; Leverage; Profit Level; Stop Level (each as Ticks or Price); QTY precision [S13][S15] |
| Defaults | accountSize 1000; lotSize 1; risk 25, riskDisplayMode percents; currency NONE; line #808080 w1; profit rgba(8,153,129,0.2), stop rgba(242,54,69,0.2), transparency 80; text #ffffff 12px on #585858; price labels on; alwaysShowStats false; compact false. Long and short identical [S19] |
| Style | Lines (color, thickness); Stop Color; Target Color; Text (color, size); Price labels; Stats; Compact stats mode; Always show stats [S13] |
| Shown | position size (qty); account balance at TP and at SL; target and stop (price, %, ticks); P&L; qty; R:R; open/closed PnL [S15] |
| Formulas (long) | Qty=min(QtyRisk,QtyLvg); QtyRisk=(RiskSize/((Entry−Stop)·PointValue))/LotSize; QtyLvg=(Account·Leverage/Entry)·PointValue/LotSize; R:R=(Profit−Entry)/(Entry−Stop); RiskSize = Risk or Risk/100·Account. Short mirrors signs [S15] |
| Handles | entry/stop/target drag handles NF (only "zones can be manually adjusted" [S13]) |
| Other | Reverse (context menu / floating panel) flips levels around entry [S16]; one alert covers entry, stop and target [S15] |
