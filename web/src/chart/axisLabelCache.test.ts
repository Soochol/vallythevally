import type { IChartApi } from "lightweight-charts";
import { afterEach, expect, test, vi } from "vitest";
import { AxisLabelCache } from "./axisLabelCache";

function fixture() {
  const timeline = { currentTime: 1 };
  vi.stubGlobal("document", { timeline });
  const panes = [0, 1].map(() => {
    const element = {} as HTMLElement;
    const last = vi.fn(() => ({ noData: false, price: 100 }));
    const series = { options: () => ({ visible: true, lastValueVisible: true }), lastValueData: last, priceToCoordinate: (price: number) => price / 2 };
    const apply = vi.fn();
    const scale = { getVisibleRange: () => ({ from: 0, to: 200 }), options: () => ({ mode: 0, invertScale: false }), applyOptions: apply };
    const getSeries = vi.fn(() => [series]);
    const api = { getHTMLElement: () => element, getHeight: () => 300, priceScale: () => scale, getSeries } as unknown as ReturnType<IChartApi["panes"]>[number];
    return { api, last, getSeries, apply };
  });
  const chart = { panes: () => panes.map((pane) => pane.api), timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 50 }) }), options: () => ({ layout: { fontFamily: "sans-serif", fontSize: 11 } }) } as unknown as IChartApi;
  const request = vi.fn();
  const cache = new AxisLabelCache(chart, request);
  for (const pane of panes) pane.apply.mockImplementation(() => cache.record(pane.api));
  return { cache, panes, timeline, request };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("포맷 알림에서는 시리즈를 읽지 않고 같은 프레임의 입력 수집과 무효화는 각각 한 번이다", () => {
  const { cache, panes, timeline, request } = fixture();
  const pane = panes[0]!;
  cache.record(pane.api);
  cache.record(pane.api);
  expect(pane.getSeries).not.toHaveBeenCalled();
  expect(pane.last).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalled();
  expect(cache.refresh(1)).toBe(true);
  cache.record(pane.api);
  cache.refresh(1);
  expect(pane.getSeries).toHaveBeenCalledTimes(1);
  expect(pane.apply).not.toHaveBeenCalled();
  timeline.currentTime = 2;
  cache.refresh(2);
  cache.refresh(2);
  expect(pane.getSeries).toHaveBeenCalledTimes(2);
  expect(pane.apply).toHaveBeenCalledTimes(1);
});

test("같은 입력의 worker 프레임은 건너뛰고 마지막 값이 바뀐 축만 다시 계산한다", () => {
  const { cache, panes, timeline } = fixture();
  cache.refresh(1);
  for (const pane of panes) pane.apply.mockClear();
  timeline.currentTime = 2;
  cache.refresh(2);
  expect(panes.every((pane) => pane.apply.mock.calls.length === 0)).toBe(true);
  panes[1]!.last.mockReturnValue({ noData: false, price: 120 });
  timeline.currentTime = 3;
  cache.refresh(3);
  cache.refresh(3);
  expect(panes[0]!.apply).not.toHaveBeenCalled();
  expect(panes[1]!.apply).toHaveBeenCalledTimes(1);
  expect(cache.lastCoordinates(panes[1]!.api)).toEqual([60]);
});

test("한 축의 입력 수집 실패는 기본 표기로 격리하고 다른 축을 그린 뒤 다음 프레임에 복구한다", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { cache, panes, timeline } = fixture();
  cache.refresh(1);
  panes[0]!.getSeries.mockImplementationOnce(() => { throw new Error("series is being attached"); });
  panes[1]!.last.mockReturnValue({ noData: false, price: 120 });
  for (const pane of panes) pane.apply.mockClear();
  timeline.currentTime = 2;
  expect(cache.refresh(2)).toBe(true);
  expect(error).toHaveBeenCalledTimes(1);
  expect(cache.lastCoordinates(panes[0]!.api)).toEqual([]);
  expect(cache.lastCoordinates(panes[1]!.api)).toEqual([60]);
  expect(panes.every((pane) => pane.apply.mock.calls.length === 1)).toBe(true);
  timeline.currentTime = 3;
  expect(cache.refresh(3)).toBe(false);
  expect(cache.lastCoordinates(panes[0]!.api)).toEqual([50]);
  expect(panes[0]!.apply).toHaveBeenCalledTimes(2);
  expect(panes[1]!.apply).toHaveBeenCalledTimes(1);
});
