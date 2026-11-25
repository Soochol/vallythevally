import { PriceScaleMode, type IChartApi } from "lightweight-charts";
import { afterEach, expect, test, vi } from "vitest";
import { AxisLabelCache } from "./axisLabelCache";

function fixture(mode: PriceScaleMode = PriceScaleMode.Normal) {
  const timeline = { currentTime: 1 };
  vi.stubGlobal("document", { timeline });
  const visible = { from: 0, to: 50 };
  const panes = [0, 1].map(() => {
    const element = {} as HTMLElement;
    const last = vi.fn(() => ({ noData: false, price: 100 }));
    const series = { options: () => ({ visible: true, lastValueVisible: true }), lastValueData: last, priceToCoordinate: (price: number) => price / 2 };
    const apply = vi.fn();
    const scale = { getVisibleRange: () => ({ from: 0, to: 200 }), options: () => ({ mode, invertScale: false }), applyOptions: apply };
    const getSeries = vi.fn(() => [series]);
    const api = { getHTMLElement: () => element, getHeight: () => 300, priceScale: () => scale, getSeries } as unknown as ReturnType<IChartApi["panes"]>[number];
    return { api, last, getSeries, apply };
  });
  const chart = { panes: () => panes.map((pane) => pane.api), timeScale: () => ({ getVisibleLogicalRange: () => ({ ...visible }) }), options: () => ({ layout: { fontFamily: "sans-serif", fontSize: 11 } }) } as unknown as IChartApi;
  const request = vi.fn();
  const cache = new AxisLabelCache(chart, request);
  for (const pane of panes) pane.apply.mockImplementation(() => cache.record(pane.api));
  return { cache, panes, timeline, request, visible };
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

test("일반 축은 가로 이동으로 가격 범위가 그대로면 무효화하지 않고 퍼센트 축은 왼쪽 시작 봉이 바뀔 때만 무효화한다", () => {
  const normal = fixture(PriceScaleMode.Normal);
  normal.cache.refresh(1);
  for (const pane of normal.panes) pane.apply.mockClear();
  normal.visible.from = 10.4;
  normal.visible.to = 60.4;
  normal.timeline.currentTime = 2;
  expect(normal.cache.refresh(2)).toBe(false);
  expect(normal.panes.every((pane) => pane.apply.mock.calls.length === 0)).toBe(true);

  const percent = fixture(PriceScaleMode.Percentage);
  percent.cache.refresh(1);
  for (const pane of percent.panes) pane.apply.mockClear();
  percent.visible.from = 0.8;
  percent.visible.to = 50.8;
  percent.timeline.currentTime = 2;
  expect(percent.cache.refresh(2)).toBe(false);
  expect(percent.panes.every((pane) => pane.apply.mock.calls.length === 0)).toBe(true);

  percent.visible.from = 1.1;
  percent.visible.to = 51.1;
  percent.timeline.currentTime = 3;
  expect(percent.cache.refresh(3)).toBe(false);
  expect(percent.panes.every((pane) => pane.apply.mock.calls.length === 1)).toBe(true);
});

test("같은 프레임에 축 눈금을 이미 포맷했다면 가격 범위와 좌표만 바뀌어도 다음 프레임 전체 무효화를 예약하지 않는다", () => {
  const timeline = { currentTime: 1 };
  vi.stubGlobal("document", { timeline });
  let scaleRange = { from: 0, to: 200 };
  let scaleFactor = 0.5;
  const element = {} as HTMLElement;
  const series = {
    options: () => ({ visible: true, lastValueVisible: true }),
    lastValueData: () => ({ noData: false, price: 100 }),
    priceToCoordinate: (price: number) => price * scaleFactor,
  };
  const apply = vi.fn();
  const pane = {
    getHTMLElement: () => element,
    getHeight: () => 300,
    priceScale: () => ({ getVisibleRange: () => scaleRange, options: () => ({ mode: 0, invertScale: false }), applyOptions: apply }),
    getSeries: () => [series],
  } as unknown as ReturnType<IChartApi["panes"]>[number];
  const chart = { panes: () => [pane], timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 50 }) }), options: () => ({ layout: { fontFamily: "sans-serif", fontSize: 11 } }) } as unknown as IChartApi;
  const cache = new AxisLabelCache(chart, () => {});
  cache.refresh(1);
  apply.mockClear();

  scaleRange = { from: 20, to: 180 };
  scaleFactor = 0.75;
  timeline.currentTime = 2;
  expect(cache.lastCoordinates(pane)).toEqual([75]);
  cache.record(pane);
  expect(cache.refresh(2)).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
