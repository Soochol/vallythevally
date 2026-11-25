import { beforeEach, describe, expect, it } from "vitest";
import { barInterval } from "../chart/crosshairSync";
import { createChartPointerScheduler, useChartPointerStore } from "./chartPointer";

const NINE = Date.parse("2026-11-06T09:00:00+09:00") / 1000;
const DAY = Date.parse("2026-11-06T00:00:00+09:00") / 1000;

beforeEach(() => {
  useChartPointerStore.setState({ pointed: null, snap: null, brokerSyncSymbols: {} });
});

describe("차트 포인터 스토어", () => {
  it("분봉과 일봉과 주봉을 모두 기억하고 null은 마지막 봉을 유지한다", () => {
    const store = useChartPointerStore.getState();
    store.point("005930", barInterval(NINE, "5m"), 70_000);
    const first = useChartPointerStore.getState().pointed;
    expect(first).toEqual({ symbol: "005930", bar: barInterval(NINE, "5m"), close: 70_000 });

    store.point("005930", barInterval(NINE, "5m"), 70_000);
    expect(useChartPointerStore.getState().pointed).toBe(first);

    store.point("005930", null, null);
    expect(useChartPointerStore.getState().pointed).toBe(first);

    store.point("005930", barInterval(DAY, "D"), 70_700);
    expect(useChartPointerStore.getState().pointed).toEqual({
      symbol: "005930",
      bar: barInterval(DAY, "D"),
      close: 70_700,
    });

    store.point("005930", barInterval(DAY, "W"), 71_000);
    expect(useChartPointerStore.getState().pointed?.bar.period).toBe("W");
  });

  it("동기화 창 참조 카운트가 0이 되면 마지막 포인터를 비운다", () => {
    const store = useChartPointerStore.getState();
    store.addBrokerSync("005930");
    store.addBrokerSync("005930");
    store.point("005930", barInterval(NINE, "5m"), 70_000);

    store.removeBrokerSync("005930");
    expect(useChartPointerStore.getState().brokerSyncSymbols["005930"]).toBe(1);
    expect(useChartPointerStore.getState().pointed).not.toBeNull();

    store.removeBrokerSync("005930");
    expect(useChartPointerStore.getState().brokerSyncSymbols["005930"]).toBeUndefined();
    expect(useChartPointerStore.getState().pointed).toBeNull();
  });

  it("snapTo는 시각을 1분 봉 시작에 맞추고 seq를 증가시킨다", () => {
    const store = useChartPointerStore.getState();
    store.snapTo("005930", NINE + 15, 70_200);
    const first = useChartPointerStore.getState().snap;
    expect(first).toEqual({ symbol: "005930", bar: barInterval(NINE, "1m"), seq: 1 });
    expect(useChartPointerStore.getState().pointed).toEqual({ symbol: "005930", bar: barInterval(NINE, "1m"), close: 70_200 });

    store.snapTo("000660", NINE + 75, 180_000);
    expect(useChartPointerStore.getState().snap).toEqual({ symbol: "000660", bar: barInterval(NINE + 60, "1m"), seq: 2 });
  });

  it("스케줄러는 80ms 간격 안에 들어온 마지막 봉만 프레임에서 반영한다", () => {
    let now = 1_000;
    let frameCallback: (() => void) | null = null;
    let timerCallback: (() => void) | null = null;
    let timerDelay = 0;
    const commits: Array<{ symbol: string; start: number; close: number | null }> = [];
    const scheduler = createChartPointerScheduler(
      (symbol, bar, close) => commits.push({ symbol, start: bar.start, close }),
      () => null,
      80,
      {
        now: () => now,
        requestFrame: (cb) => {
          frameCallback = cb;
          return 1;
        },
        cancelFrame: () => {
          frameCallback = null;
        },
        setTimeout: (cb, ms) => {
          timerCallback = cb;
          timerDelay = ms;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {
          timerCallback = null;
        },
      },
    );

    scheduler.push("005930", barInterval(NINE, "5m"), 70_000);
    expect(commits).toHaveLength(0);
    frameCallback!();
    expect(commits).toEqual([{ symbol: "005930", start: NINE, close: 70_000 }]);

    now = 1_020;
    scheduler.push("005930", barInterval(NINE + 300, "5m"), 70_100);
    scheduler.push("005930", barInterval(NINE + 600, "5m"), 70_200);
    expect(timerDelay).toBe(60);

    now = 1_080;
    timerCallback!();
    frameCallback!();
    expect(commits).toEqual([
      { symbol: "005930", start: NINE, close: 70_000 },
      { symbol: "005930", start: NINE + 600, close: 70_200 },
    ]);
  });
});
