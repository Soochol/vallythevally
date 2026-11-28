import { describe, expect, test } from "vitest";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { windowId } from "../../layout/kinds";
import type { EditableLayout, GroupSymbols } from "../../stores/layout";
import type { TickReplayTarget } from "../../stores/tickReplay";
import { matchesTickReplayWindow, shouldStopTickReplayOnLayout } from "./scope";

const SAMSUNG: SymbolCode = "005930";
const HYNIX: SymbolCode = "000660";

function makeLayout(): EditableLayout {
  return {
    id: "layout-1",
    name: "기본",
    sync: { crosshair: true, scroll: true, crosshairScope: "all" },
    windows: [
      { id: windowId("cell-a"), link: "a", kind: "chart", symbol: SAMSUNG, period: "1m", chartSettings: DEFAULT_CHART_SETTINGS },
      { id: windowId("book-a"), link: "a", kind: "book" },
      { id: windowId("book-b"), link: "b", kind: "book" },
      { id: windowId("book-unlinked"), link: null, kind: "book" },
      { id: windowId("cell-unlinked"), link: null, kind: "chart", symbol: SAMSUNG, period: "5m", chartSettings: DEFAULT_CHART_SETTINGS },
    ],
    placement: { v: 1, dock: null, canvas: null },
  };
}

describe("tick-replay scope", () => {
  test("matches same linked group windows and excludes other link groups or symbols", () => {
    const layout = makeLayout();
    const target: TickReplayTarget = {
      cellId: windowId("cell-a"),
      symbol: SAMSUNG,
      link: "a",
      date: "20261125",
      start: { kind: "dayStart" },
      autoPlay: true,
    };

    expect(matchesTickReplayWindow(layout, windowId("cell-a"), SAMSUNG, target)).toBe(true);
    expect(matchesTickReplayWindow(layout, windowId("book-a"), SAMSUNG, target)).toBe(true);
    expect(matchesTickReplayWindow(layout, windowId("book-b"), SAMSUNG, target)).toBe(false);
    expect(matchesTickReplayWindow(layout, windowId("book-unlinked"), SAMSUNG, target)).toBe(false);
    expect(matchesTickReplayWindow(layout, windowId("book-a"), HYNIX, target)).toBe(false);
    expect(matchesTickReplayWindow(layout, undefined, SAMSUNG, target)).toBe(false);
  });

  test("matches any same-symbol window when started from an unlinked chart", () => {
    const layout = makeLayout();
    const target: TickReplayTarget = {
      cellId: windowId("cell-unlinked"),
      symbol: SAMSUNG,
      link: null,
      date: "20261125",
      start: { kind: "dayStart" },
      autoPlay: true,
    };

    expect(matchesTickReplayWindow(layout, windowId("cell-unlinked"), SAMSUNG, target)).toBe(true);
    expect(matchesTickReplayWindow(layout, windowId("book-a"), SAMSUNG, target)).toBe(true);
    expect(matchesTickReplayWindow(layout, windowId("book-unlinked"), SAMSUNG, target)).toBe(true);
    expect(matchesTickReplayWindow(layout, windowId("book-a"), HYNIX, target)).toBe(false);
  });

  test("detects exit when linked group symbol changes, source chart changes symbol, or source chart closes", () => {
    const layout = makeLayout();
    const target: TickReplayTarget = {
      cellId: windowId("cell-a"),
      symbol: SAMSUNG,
      link: "a",
      date: "20261125",
      start: { kind: "dayStart" },
      autoPlay: true,
    };
    const sameGroup: GroupSymbols = { a: SAMSUNG };
    expect(shouldStopTickReplayOnLayout(layout, sameGroup, target)).toBe(false);

    expect(shouldStopTickReplayOnLayout(layout, { a: HYNIX }, target)).toBe(true);

    const switchedSource: EditableLayout = {
      ...layout,
      windows: layout.windows.map((w) => (w.id === windowId("cell-a") && w.kind === "chart" ? { ...w, symbol: HYNIX } : w)),
    };
    expect(shouldStopTickReplayOnLayout(switchedSource, sameGroup, target)).toBe(true);

    const closedSource: EditableLayout = {
      ...layout,
      windows: layout.windows.filter((w) => w.id !== windowId("cell-a")),
    };
    expect(shouldStopTickReplayOnLayout(closedSource, sameGroup, target)).toBe(true);
  });

  test("detects exit for unlinked chart only when source chart closes or changes symbol", () => {
    const layout = makeLayout();
    const target: TickReplayTarget = {
      cellId: windowId("cell-unlinked"),
      symbol: SAMSUNG,
      link: null,
      date: "20261125",
      start: { kind: "dayStart" },
      autoPlay: true,
    };
    expect(shouldStopTickReplayOnLayout(layout, { a: HYNIX }, target)).toBe(false);

    const switchedSource: EditableLayout = {
      ...layout,
      windows: layout.windows.map((w) => (w.id === windowId("cell-unlinked") && w.kind === "chart" ? { ...w, symbol: HYNIX } : w)),
    };
    expect(shouldStopTickReplayOnLayout(switchedSource, {}, target)).toBe(true);
  });
});
