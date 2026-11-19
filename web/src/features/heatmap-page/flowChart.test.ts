import { expect, test } from "vitest";
import type { HeatmapFlowPoint } from "../../api/generated/HeatmapFlowPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { hourTicks, linePath, rateExtent, rateTicks, spreadLabels, timeExtent } from "./flowChart";

const point = (t: number, rate: number): HeatmapFlowPoint => ({ t: t as UnixSeconds, rate });

test("등락률 범위는 0을 늘 포함하고 여백을 둔다", () => {
  const extent = rateExtent([1.2, 3.4]);
  expect(extent.min).toBeLessThan(0);
  expect(extent.max).toBeGreaterThan(3.4);
  expect(rateExtent([]).min).toBeLessThan(0);
});

test("눈금은 범위 안의 깔끔한 간격이고 일곱 개를 넘지 않는다", () => {
  expect(rateTicks({ min: -0.5, max: 3.2 })).toEqual([0, 1, 2, 3]);
  expect(rateTicks({ min: -10, max: 12 }).length).toBeLessThanOrEqual(7);
  expect(rateTicks({ min: -0.3, max: 0.3 })).toEqual([-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]);
});

test("시간 눈금은 한국 시각 정각이다", () => {
  const nineKst = Date.UTC(2026, 10, 19, 0, 0) / 1000;
  const ticks = hourTicks({ min: nineKst + 60, max: nineKst + 3 * 3600 + 60 });
  expect(ticks).toEqual([nineKst + 3600, nineKst + 7200, nineKst + 10800]);
});

test("점이 하나여도 시간 범위는 넓이를 가진다", () => {
  const extent = timeExtent([1000]);
  expect(extent.max - extent.min).toBeGreaterThan(0);
});

test("경로는 점마다 이어지고 결측 없이 첫 점에서 시작한다", () => {
  expect(linePath([point(0, 1), point(10, 2)], (t) => t, (r) => r * 10)).toBe("M0.0,10.0 L10.0,20.0");
  expect(linePath([], (t) => t, (r) => r)).toBe("");
});

test("가까운 끝 라벨은 간격을 벌리고 아래 끝을 넘지 않는다", () => {
  expect(spreadLabels([100, 102, 300], 14, 400)).toEqual([100, 114, 300]);
  expect(spreadLabels([390, 392], 14, 400)).toEqual([386, 400]);
  expect(spreadLabels([50], 14, 400)).toEqual([50]);
});
