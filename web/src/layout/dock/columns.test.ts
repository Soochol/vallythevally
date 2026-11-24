import { expect, test } from "vitest";
import { windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { shiftColumns } from "./columns";
import { drawDock, layoutDock } from "./geometry";

const AREA = { w: 1606, h: 1500 };
const GAP = 6;
const kinds: Record<string, WindowKind> = { chart: "chart", chart2: "chart", order: "order", book: "book", watch: "watchlist", ranking: "ranking" };
const refs = (rateHidden: boolean): WindowRef[] => Object.entries(kinds).map(([id, kind]) => ({ id: windowId(id), kind, rateHidden: rateHidden && (kind === "order" || kind === "book") }));
const group = (...tabs: string[]): DockNode => ({ kind: "group", id: tabs.join("+"), tabs: tabs.map(windowId), active: windowId(tabs[0]!) });
const row = (ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir: "row", ratio, first, second });
const column = (ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir: "column", ratio, first, second });
const dockOf = (root: DockNode): DockPlacement => ({ root, floats: [] });
const widths = (dock: DockPlacement, rateHidden = false) => Object.fromEntries(layoutDock(drawDock(dock, { area: AREA, gap: GAP, windows: refs(rateHidden) }).dock.root, AREA, GAP).groups.map(({ group: { id }, rect }) => [id, rect.w]));
const shift = (dock: DockPlacement, show: boolean): DockPlacement =>
  shiftColumns(dock, {
    targets: new Set([windowId("order"), windowId("book")]),
    change: show ? 48 : -48,
    before: { area: AREA, gap: GAP, windows: refs(show) },
    after: { area: AREA, gap: GAP, windows: refs(!show) },
  });
const changes = (before: DockPlacement, after: DockPlacement, rateHidden: boolean) => {
  const from = widths(before);
  return Object.fromEntries(Object.entries(widths(after, rateHidden)).map(([id, w]) => [id, w - from[id]!]));
};

const cases: readonly [string, DockNode, Record<string, number>][] = [
  ["오른쪽 칸", row(0.6, group("chart"), group("order")), { chart: 48, order: -48 }],
  ["왼쪽 칸", row(0.4, group("order"), group("chart")), { order: -48, chart: 48 }],
  ["탭으로 함께 든 칸", row(0.6, group("chart"), group("watch", "order", "book")), { chart: 48, "watch+order+book": -48 }],
  ["세로 기둥에 두 사다리", row(0.6, group("chart"), column(0.5, group("order"), group("book"))), { chart: 48, order: -48, book: -48 }],
  ["세로 기둥에 다른 창", row(0.6, group("chart"), column(0.5, group("order"), group("watch"))), { chart: 48, order: -48, watch: -48 }],
  ["나란한 두 사다리는 바깥 칸이 둘을 받는다", row(0.4, group("chart"), row(0.5, group("order"), group("book"))), { chart: 96, order: -48, book: -48 }],
  ["가운데 낀 칸", row(0.35, group("chart"), row(0.5, group("order"), group("chart2"))), { chart: 0, order: -48, chart2: 48 }],
  ["안쪽 나눔까지 따로 주고받는다", row(0.35, group("order"), row(0.4, group("book"), group("chart"))), { order: -48, book: -48, chart: 96 }],
  ["옆 칸이 없는 세로 배치", column(0.5, group("order"), group("chart")), { order: 0, chart: 0 }],
  ["나란한 두 사다리뿐인 배치", row(0.5, group("order"), group("book")), { order: 0, book: 0 }],
];

for (const [name, root, wanted] of cases) {
  test(`${name}: 끄면 정한 만큼 옮기고 켜면 처음 폭이다`, () => {
    const start = dockOf(root);
    const off = shift(start, false);
    expect(changes(start, off, true)).toEqual(wanted);
    expect(changes(start, shift(off, true), false)).toEqual(Object.fromEntries(Object.keys(wanted).map((id) => [id, 0])));
  });
}

test("열 번 끄고 켜도 폭이 새지 않는다", () => {
  const start = dockOf(row(0.37, group("chart"), row(0.61, group("chart2"), column(0.5, group("order"), group("book")))));
  let dock = start;
  for (let round = 0; round < 10; round += 1) dock = shift(shift(dock, false), true);
  expect(widths(dock)).toEqual(widths(start));
});

test("함께 있는 다른 창의 최소 폭에서 멈춘다", () => {
  const start = dockOf(row(0.78, group("chart"), group("book", "ranking")));
  expect(widths(start)["book+ranking"]).toBeLessThan(368);
  expect(widths(shift(start, false), true)["book+ranking"]).toBe(320);
});

test("사다리 창이 없으면 같은 배치를 돌려준다", () => {
  const start = dockOf(row(0.6, group("chart"), group("watch")));
  expect(shift(start, false)).toBe(start);
});
