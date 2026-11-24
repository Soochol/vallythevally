import { expect, test } from "vitest";
import { windowId, type WindowKind, type WindowRef } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { equalizeAll, equalizeRun } from "./balance";
import { defaultDock, WIDE_SHARE, type WindowList } from "./fit";
import { layoutDock, leadLength, moveDivider, ratioForLead, tabsMinSize, type DockSpace } from "./geometry";
import { findJunctions } from "./junction";
import { applyPreset, pushDivider } from "./push";
import { dividerStops, nextStop, presetLead, snapLead, type Stop } from "./stops";

const ref = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind, rateHidden: false });
const group = (id: string, tab: string): DockNode => ({ kind: "group", id, tabs: [windowId(tab)], active: windowId(tab) });
const split = (dir: "row" | "column", ratio: number, first: DockNode, second: DockNode): DockNode => ({ kind: "split", dir, ratio, first, second });
const placed = (root: DockNode): DockPlacement => ({ root, floats: [] });

const windows = [ref("c1", "chart"), ref("c2", "chart"), ref("c3", "chart"), ref("w", "watchlist"), ref("s", "screener")];
const space: DockSpace = { area: { w: 1256, h: 684 }, gap: 6, windows };

const undersized = (root: DockNode, at: DockSpace) =>
  layoutDock(root, at.area, at.gap).groups.filter(({ group: node, rect }) => {
    const least = tabsMinSize(at.windows, node.tabs);
    return rect.w < least.w || rect.h < least.h;
  });

const widths = (root: DockNode, at: DockSpace) => layoutDock(root, at.area, at.gap).groups.map((box) => box.rect.w);
const heights = (root: DockNode, at: DockSpace) => layoutDock(root, at.area, at.gap).groups.map((box) => box.rect.h);
const leads = (stops: Stop[]) => stops.map((stop) => stop.lead);

const basicWindows: WindowList = [ref("c1", "chart"), ref("w", "watchlist"), ref("s", "screener")];
const basicSpace = (width: number): DockSpace => ({ area: { w: width, h: 800 }, gap: 6, windows: basicWindows });

test("1440×800 기본 도킹의 좌우 경계 후보에 1/2, 2/3, 기본 몫이 있다", () => {
  const dock = defaultDock(basicWindows);
  const stops = dividerStops(dock, [], basicSpace(1440));
  expect(stops).toContainEqual({ kind: "ratio", lead: leadLength(1 / 2, 1440, 6), guide: leadLength(1 / 2, 1440, 6) });
  expect(stops.find((stop) => stop.lead === leadLength(2 / 3, 1440, 6))?.kind).toBe("ratio");
  expect(stops.find((stop) => stop.lead === leadLength(WIDE_SHARE, 1440, 6))?.kind).toBe("default");
  expect(stops.every((stop) => stop.guide === stop.lead)).toBe(true);
});

test("보조 묶음 최소 폭을 어기는 후보는 빠진다", () => {
  const stops = dividerStops(defaultDock(basicWindows), [], basicSpace(1000));
  expect(leads(stops)).toContain(leadLength(1 / 2, 1000, 6));
  expect(leads(stops)).not.toContain(leadLength(3 / 4, 1000, 6));
  expect(stops.every((stop) => 1000 - 6 - stop.lead >= 280 && stop.lead >= 280)).toBe(true);
});

test("차트 둘을 좌우로 나눈 묶음 아래의 다른 좌우 나눔과 줄이 맞는 후보를 낸다", () => {
  const dock = placed(split("column", 0.5, split("row", 0.5, group("g1", "c1"), group("g2", "c2")), split("row", 0.3, group("g3", "w"), group("g4", "s"))));
  const lower = layoutDock(dock.root, space.area, space.gap).gutters.find((gutter) => gutter.path.join() === "second");
  const stops = dividerStops(dock, ["first"], space);
  const aligned = stops.find((stop) => stop.kind === "align");
  expect(aligned).toEqual({ kind: "align", lead: lower?.rect.x, guide: lower?.rect.x });
});

test("붙이기는 8px 안의 가장 가까운 후보에 붙고 9px 떨어지면 붙지 않는다", () => {
  const stops: Stop[] = [{ kind: "ratio", lead: 400, guide: 400 }, { kind: "default", lead: 700, guide: 700 }];
  expect(snapLead(408, stops)).toEqual({ lead: 400, stop: stops[0] });
  expect(snapLead(392, stops)).toEqual({ lead: 400, stop: stops[0] });
  expect(snapLead(409, stops)).toEqual({ lead: 409, stop: null });
  expect(snapLead(401, stops, 0)).toEqual({ lead: 401, stop: null });
});

test("두 후보가 같은 거리면 입력 순서와 무관하게 앞쪽 후보에 붙는다", () => {
  const low: Stop = { kind: "ratio", lead: 100, guide: 100 };
  const high: Stop = { kind: "ratio", lead: 116, guide: 116 };
  expect(snapLead(108, [low, high]).lead).toBe(100);
  expect(snapLead(108, [high, low]).lead).toBe(100);
});

test("다음 달라붙는 자리는 한 방향의 가장 가까운 후보다", () => {
  const stops: Stop[] = [300, 500, 800].map((lead) => ({ kind: "ratio", lead, guide: lead }));
  expect(nextStop(500, stops, 1)?.lead).toBe(800);
  expect(nextStop(500, stops, -1)?.lead).toBe(300);
  expect(nextStop(450, stops, 1)?.lead).toBe(500);
  expect(nextStop(800, stops, 1)).toBeNull();
  expect(nextStop(300, stops, -1)).toBeNull();
});

const stack3 = placed(split("column", 1 / 3, group("g1", "c1"), split("column", 0.5, group("g2", "c2"), group("g3", "c3"))));

test("세로로 쌓은 차트 셋의 경계 하나를 고르게 하면 세 묶음 높이가 1px 안으로 같다", () => {
  const skewed = placed(split("column", 0.6, group("g1", "c1"), split("column", 0.3, group("g2", "c2"), group("g3", "c3"))));
  for (const path of [[], ["second"]] as const) {
    const even = equalizeRun(skewed, path, space);
    const sizes = heights(even.root, space);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((sum, size) => sum + size, 0) + 2 * 6).toBe(684);
    expect(undersized(even.root, space)).toEqual([]);
  }
});

test("최소 높이 때문에 못 고르면 모든 묶음이 최소 이상이다", () => {
  const short: DockSpace = { ...space, area: { w: 1256, h: 3 * 194 + 12 + 20 } };
  const even = equalizeRun(stack3, [], short);
  const sizes = heights(even.root, short);
  expect(sizes.every((size) => size >= 194)).toBe(true);
  expect(undersized(even.root, short)).toEqual([]);
  const tooShort: DockSpace = { ...space, area: { w: 1256, h: 400 } };
  expect(equalizeRun(stack3, [], tooShort)).toBe(stack3);
});

test("모두 고르게 뒤 모든 묶음이 최소 크기 이상이다", () => {
  const nested = placed(
    split(
      "row",
      0.8,
      split("column", 0.7, split("row", 0.2, group("g1", "c1"), group("g2", "c2")), group("g3", "c3")),
      split("column", 0.9, group("g4", "w"), group("g5", "s")),
    ),
  );
  for (const at of [space, { ...space, area: { w: 900, h: 620 } }]) {
    const even = equalizeAll(nested, at);
    expect(undersized(even.root, at)).toEqual([]);
  }
  const even = equalizeAll(nested, space);
  const [g1, g2] = widths(even.root, space);
  expect(Math.abs((g1 ?? 0) - (g2 ?? 0))).toBeLessThanOrEqual(1);
});

test("반반·1:2·2:1·기본 몫 프리셋이 맞는 lead를 낸다", () => {
  const dock = defaultDock(basicWindows);
  const at = basicSpace(1440);
  expect(presetLead(dock, [], at, "half")).toEqual({ lead: leadLength(1 / 2, 1440, 6), clamped: false });
  expect(presetLead(dock, [], at, "one-two")).toEqual({ lead: leadLength(1 / 3, 1440, 6), clamped: false });
  expect(presetLead(dock, [], at, "two-one")).toEqual({ lead: leadLength(2 / 3, 1440, 6), clamped: false });
  expect(presetLead(dock, [], at, "default")).toEqual({ lead: leadLength(WIDE_SHARE, 1440, 6), clamped: false });
  const applied = applyPreset(dock, [], "half", at);
  expect(widths(applied.dock.root, at)).toEqual([717, 717]);
});

test("프리셋이 최소 크기에 걸리면 가장 가까운 허용 값으로 하고 걸렸다고 알린다", () => {
  const dock = defaultDock(basicWindows);
  const narrow = basicSpace(700);
  const result = presetLead(dock, [], narrow, "two-one");
  expect(result).toEqual({ lead: 700 - 6 - 280, clamped: true });
  const applied = applyPreset(dock, [], "two-one", narrow);
  expect(applied.clamped).toBe(true);
  expect(undersized(applied.dock.root, narrow)).toEqual([]);
});

const pushTree = placed(split("row", 0.5, group("g1", "c1"), split("row", 0.6, group("g2", "c2"), group("g3", "w"))));

test("밀어내기는 큰 쪽 안쪽 묶음부터 줄이고 moveDivider가 멈추는 자리보다 더 간다", () => {
  const before = widths(pushTree.root, space);
  expect(before).toEqual([625, 373, 246]);
  const target = ratioForLead(700, 1256, 6);
  const held = moveDivider(pushTree, [], target, space);
  expect(held.clamped).toBe(true);
  const pushed = pushDivider(pushTree, [], target, space);
  expect(pushed.clamped).toBe(false);
  const after = widths(pushed.dock.root, space);
  expect(after[0]).toBe(700);
  expect(after[1]).toBeLessThan(before[1] ?? 0);
  expect(after[2]).toBe(before[2]);
  expect(after[1]).toBeGreaterThanOrEqual(280);
});

test("안쪽 묶음이 모두 최소에 닿으면 clamped로 멈춘다", () => {
  const pushed = pushDivider(pushTree, [], 0.99, space);
  expect(pushed.clamped).toBe(true);
  expect(widths(pushed.dock.root, space)).toEqual([1256 - 6 - 280 - 6 - 220, 280, 220]);
});

test("밀어내기 결과를 그리면 모든 묶음이 최소 이상이고 틈이 6px로 유지된다", () => {
  for (const ratio of [0.55, 0.7, 0.8, 0.99]) {
    const pushed = pushDivider(pushTree, [], ratio, space);
    expect(undersized(pushed.dock.root, space)).toEqual([]);
    expect(layoutDock(pushed.dock.root, space.area, space.gap).gutters.map((gutter) => gutter.rect.w)).toEqual([6, 6]);
  }
});

test("늘어나는 쪽의 안쪽 비율은 그대로다", () => {
  const pushed = pushDivider(pushTree, [], 0.3, space);
  expect(pushed.clamped).toBe(false);
  const inner = pushed.dock.root.kind === "split" ? pushed.dock.root.second : null;
  expect(inner?.kind === "split" && inner.ratio).toBe(0.6);
  expect(undersized(pushed.dock.root, space)).toEqual([]);
});

test("줄어드는 쪽이 첫째일 때도 안쪽 묶음이 최소를 지킨다", () => {
  const mirrored = placed(split("row", 0.5, split("row", 0.4, group("g1", "w"), group("g2", "c2")), group("g3", "c1")));
  const pushed = pushDivider(mirrored, [], 0.05, space);
  expect(pushed.clamped).toBe(true);
  expect(undersized(pushed.dock.root, space)).toEqual([]);
  expect(widths(pushed.dock.root, space)[0]).toBe(220);
});

test("밀어내기는 없는 경계와 NaN에서 배치를 바꾸지 않는다", () => {
  expect(pushDivider(pushTree, ["first"], 0.5, space)).toEqual({ dock: pushTree, clamped: false });
  expect(pushDivider(pushTree, [], NaN, space).dock).toBe(pushTree);
});

test("세 묶음 배치에서 교차점 하나를 찾아 두 경계의 경로를 낸다", () => {
  const dock = placed(split("row", 0.72, split("column", 0.5, group("g1", "c1"), group("g2", "s")), group("g3", "w")));
  const layout = layoutDock(dock.root, space.area, space.gap);
  const found = findJunctions(layout);
  expect(found).toHaveLength(1);
  const [junction] = found;
  expect(junction?.rowPath).toEqual([]);
  expect(junction?.columnPath).toEqual(["first"]);
  const row = layout.gutters[0]?.rect;
  const column = layout.gutters[1]?.rect;
  expect(junction?.rect).toEqual({ x: (row?.x ?? 0) + 3 - 6, y: (column?.y ?? 0) + 3 - 6, w: 12, h: 12 });
});

test("나눔이 하나뿐인 기본 배치에는 교차점이 없다", () => {
  const at = basicSpace(1440);
  expect(findJunctions(layoutDock(defaultDock(basicWindows).root, at.area, at.gap))).toEqual([]);
});
