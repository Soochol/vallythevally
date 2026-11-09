# TradingView drawing editing UX — sourced facts (2026-11-09)

Refs `[Sn]` point to `sources.md`. "Ctrl" means Ctrl on Windows/Linux and ⌘ on Mac unless noted. S1 is the Charting Library (Advanced Charts) shortcut table, which is TradingView-official but documents the embeddable library, not the tradingview.com app; where a support article or blog post confirms the same key for the app, both refs are given.

Live check on tradingview.com as a guest: the shortcut dialog could be read [S42]. Drawing itself opened a sign-up wall, so the floating toolbar, context menu, and settings dialog could not be observed.

## 1. Keyboard shortcuts

Primary source: the in-app Keyboard shortcuts dialog (Ctrl+/) on tradingview.com, observed 2026-11-09 [S42]. Mac keys are ⌘ for Ctrl and ⌥ for Alt [S22, S23]; the Mac rendering was not observed.

| Action | Key (Win/Linux) | Ref |
|---|---|---|
| Trendline tool | Alt+T | S42, S1, S24, S28 |
| Horizontal line tool | Alt+H | S42, S1, S28 |
| Horizontal ray tool | Alt+J | S42 (in-app only) |
| Vertical line tool | Alt+V | S42, S1, S28 |
| Crossline tool | Alt+C | S42, S1, S28 |
| Fib retracement tool | Alt+F | S42, S1, S24 |
| Rectangle tool | Shift+Alt+R | S42, S1, S22 |
| Undo / Redo | Ctrl+Z / Ctrl+Y | S42, S1, S14 |
| Copy selected object / Paste object | Ctrl+C / Ctrl+V | S42, S1 |
| Remove object | Delete, Backspace, or mouse-wheel click | S42, S23 |
| Clone a drawing | Ctrl + Drag | S42, S1, S4 |
| Drawings multiselect | Hold Ctrl + Click (area: Ctrl + left-drag) | S42, S5, S8 |
| Hide all drawings (toggle) | Ctrl+Alt+H | S42, S23 |
| Temporarily turn magnet on/off | Ctrl + move a point (also while drawing) | S42, S7, S9 |
| Move a drawing only horizontally or vertically | Drag + Shift | S42, S3 |
| Move selected drawing | Arrow keys (←/→ 1 bar, ↑/↓ 1 mintick) | S42, S3 |
| "45 degrees angle or horizontal" | Shift with Trendline or Channel | S42, S6 |
| Square / Circle | Shift with Rectangle / Ellipse | S42, S1 |
| Measure tool | Hold Shift + Click | S42, S1 |
| Gann box fixed increments | Hold Shift | S42 |
| Partially erase | Ctrl + Eraser | S42 |
| **Draw with demonstration cursor** | **Hold Alt + Draw** | S42 |
| Switch cells in a table drawing | Tab / Shift+Tab | S42 |
| Delete one Fib level | Ctrl + wheel click on the level | S23 |
| Open the shortcut list | Ctrl+/ | S22, S42 |
| Esc cancels a half-drawn object | not in the dialog; secondary source only | S40 |
| Ctrl+D, Ctrl+A (select all drawings), lock-all hotkey, visual-order hotkeys | not in the dialog or any source | S42 |

## 2. Clone by drag
The modifier is **Ctrl/Command**, not Alt: "hold Ctrl/Command and then drag the figure" [S4]; "Clone: Ctrl+drag" [S1]. Works on a multi-selection [S4]. The in-app dialog says "Clone a drawing — Ctrl + Drag" [S42]. **The project issue's Alt assumption does not match any source.** TradingView also already binds Alt to two other actions: "Hold Alt + Draw" switches to the demonstration cursor, and Alt+letter selects a tool [S42].

## 3. Shift
- While drawing a Trendline or Channel: "45 degrees angle or horizontal" [S42], or "an angle multiple of 45 degrees" [S6, S39]. The sources list no other tools for this.
- Rectangle + Shift draws a square; Ellipse + Shift draws a circle [S1].
- Shift while dragging an existing drawing: moves "strictly horizontally/vertically from their start point" [S3, S1].
- Shift + click: measure [S1]. Shift on Gann box: fixed increments [S1].

## 4. Floating drawing toolbar (shown when a drawing is selected)
Buttons confirmed by sources:
- Templates button or dropdown [S19, S21]. For several same-type drawings, the template option also appears there [S20, S34].
- Text, line, and fill color [S33].
- Settings button, which applies to all selected objects [S27].
- Lock/Unlock button [S32].
- Three-dots "more" menu holding "Intervals visibility" [S17]. Library release notes mention a context menu for the floating toolbar (search snippet only).
- Copy, per the object-copying blog (snippet only; fetch returned 404).
- Line thickness and style, from a secondary source only [S40].

Not found in any source: a complete ordered button list, a Delete button, Create alert, Visual order, or Clone on the floating toolbar. Long and short position drawings can add an alert from their floating toolbar, per a blog search snippet ("alerts-long-and-short-position-60470"), which was not fetched.

## 5. Last-used style and templates
- "Each drawing tool has its own default properties, such as color and size" that users can change [S19].
- "Every drawing tool in TradingView remembers the last style you used" comes from a **secondary source only** [S40]. No official source confirms it.
- Templates are named and saved per tool type. You save and apply them through the Templates control [S19, S21, S40]. A template can be applied to several selected same-type drawings at once, from the floating toolbar or the context menu [S20, S34]. In the Charting Library, templates are a Trading Platform-only feature [S19].
- A "save as default" or "apply default" template item: **not found**.

## 6. Lock, hide, stay in drawing mode, magnet
- **Lock all drawings** (left toolbar): "prevents accidental movement of drawings" [S14]. Each drawing also has its own Lock/Unlock toggle in the floating toolbar [S32]. Removing a locked drawing opens a dialog with deletion options. "Don't show again" makes that choice the default, and "Always remove locked drawings" sits under Remove options [S35].
- **Hide**: the left-toolbar Hide options are Drawings, Indicators, Positions and orders, or All [S14, S15, S19]. Ctrl+Alt+H toggles drawings [S23]. Hiding a single drawing is library action `lineHide` [S32]. A secondary source puts it in a right-click "Lock and Hide" submenu [S40].
- **Stay in drawing mode / Keep drawing**: "add multiple objects to the chart successively". Without it, "you will return to your cursor" after each drawing [S14, S29, S32]. **Not found:** double-clicking a tool to make it sticky.
- **Magnet**:
  - Strong: "Forces drawings to glue to the open, high, low, or close prices" [S14].
  - Weak: "Allows your drawings to be placed at a distance from the price" [S14].
  - A secondary source says weak snaps only "within a few pixels" [S40]. No official pixel threshold was found.
  - Optional "Snap to indicators" also snaps to overlay indicator values [S14].
  - Holding Ctrl temporarily turns magnet on when it is off. The 2019 blog says this turns on *strong* magnet [S9]. Holding Ctrl also temporarily turns magnet off when it is on, and works while editing points [S7, S9, S1].

## 7. Visual order, multi-select, Object Tree
- **Visual order**: right-click → "Visual Order", also available in the Object Tree [S25]. Z-order can be changed for one or several drawings [S12]. Dragging an object in the Object Tree changes its z-order (library doc search snippet only; the fetched page [S43] doesn't say this). **The submenu item names (Bring to front, Bring forward, and so on) were not found.**
- **Multi-select**: Ctrl + click, or Ctrl + left-drag over an area (box select) [S5, S8, S33]. Objects can also be multi-selected in the Object Tree [S27]. A selection can be moved, deleted, copied, cloned, recolored, or given shared settings [S4, S5, S27, S33]. The "Displacement" tab shifts selected objects by a typed offset [S8].
- **Object Tree** (right panel) manages drawings, indicators, and symbols [S12, S26]:
  - Groups, with visibility toggled per group [S12].
  - Rename via context menu → Rename [S13].
  - "Manage layout drawings" groups drawings by symbol and sorts them by last-modified date or by name [S36].
  - Per-row lock and hide icons are **not described** in the fetched sources.

## 8. Undo/redo scope
"All changes on the chart can be managed with the help of the Undo and Redo buttons" [S26]. An accidental drawing move can be reverted with Ctrl+Z [S14]. Exception: undo does not restore drawings deleted "on a symbol not currently open on the chart" [S11]. The sources don't say whether style-only edits each create an undo step.

## 9. Settings dialog
The tool pages show four sections: **Style / Text / Coordinates / Visibility** [S38, S39].
- **Style**: line color, opacity, thickness, and style, plus tool-specific items. For a trend line: middle point, price labels, stats, and "Always show stats" [S39]. For a vertical line: extend through panes and a time label [S38].
- **Text**: text, color, size, bold, italic, and alignment [S38].
- **Coordinates**: each point as bar number + price [S38, S39].
- **Visibility**: choose which intervals show the drawing [S16]. Quick presets come from the context menu or the floating toolbar's ⋯ menu ("Intervals visibility") and fill in this tab [S17, S18]. The fetched text doesn't name the preset or interval-unit rows.
- A **Displacement** tab exists for multi-selection [S8].
- A Template control in the dialog appears in secondary sources only [S40]. Officially it is documented on the floating panel [S21].

## 10. Sync and symbol attachment
Three modes [S11, S37, S10]:
- **Off**: the drawing is saved only on that chart of that layout.
- **Layout**: syncs "drawings on the current symbol" across all charts in the layout.
- **Global**: syncs across all charts and layouts. Switching a drawing to global removes it from other layouts.

Sync is set with the globe icon on the left toolbar, or per drawing via the context menu's "Sync globally" [S10]. Sync groups "appear on all charts with this symbol" [S10]. Drawings are therefore tied to symbol + chart/layout. With autosave on, drawing changes save immediately [S11].

## Conflicts
- **Magnet strong vs weak**: S14 (official) says strong = any of O/H/L/C. EBC [S41, secondary] says strong = high/low only and weak also allows open/close. Use S14.
- **Clone modifier**: the issue assumes Alt; every source says Ctrl/⌘.
- **Ctrl magnet toggle**: S9 says Ctrl turns on the *strong* magnet. S7 just says "magnet". Which mode a temporary toggle uses when the saved mode is Weak is unverified.

## Unverified / not found
Esc (secondary only); Ctrl+D; Ctrl+A for drawings; lock-all hotkey; full floating toolbar button list; Visual Order submenu labels; double-click on a tool to make it sticky; "remember last style" (secondary only); default-template commands; per-row icons in the Object Tree; how undo steps are grouped.
