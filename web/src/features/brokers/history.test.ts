import { describe, expect, it } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import { boardAxis } from "./board";
import { priceAt } from "./history";
import { EMPTY_BROKER_STATE, appendSnapshots, reduceBrokers } from "./model";

const entry = (code: string, qty: number) => ({ code, name: `사${code}`, qty, qtyChange: 0 });
const feed = (t: number, buys: [string, number][], sells: [string, number][] = []): FeedBrokers => ({ t, buys: buys.map(([c, q]) => entry(c, q)), sells: sells.map(([c, q]) => entry(c, q)) });
const kst = (clock: string) => Date.parse(`2026-11-24T${clock}+09:00`) / 1000;
const bar = (t: number, close: number): Bar => ({ t, o: close, h: close, l: close, c: close, v: 1 });

describe("거래원 수집 자료", () => {
  it("묶음으로 더한 결과는 하나씩 더한 결과와 같다", () => {
    const feeds = [feed(60, [["a", 100]], [["b", 30]]), feed(120, [["a", 150]]), feed(180, [["c", 5]], [["b", 40]]), feed(240, [["a", 150], ["b", 10]], [["b", 40]]), feed(300, [["c", 9]]), feed(360, [["a", 170]], [["d", 8]])];
    const one = feeds.reduce((state, brokers) => reduceBrokers(state, { type: "snapshot", brokers }), EMPTY_BROKER_STATE);
    const all = appendSnapshots(EMPTY_BROKER_STATE, feeds, []);
    expect(all.grid).toEqual(one.grid);
    expect(appendSnapshots(appendSnapshots(EMPTY_BROKER_STATE, feeds.slice(0, 2), []), feeds.slice(2), []).grid).toEqual(one.grid);
  });

  it("같은 초의 뒤 행은 앞 행을 대신한다", () => {
    const { grid } = appendSnapshots(EMPTY_BROKER_STATE, [feed(60, [["a", 100]]), feed(120, [["a", 150]]), feed(120, [["a", 170]])], []);
    expect(grid.times).toEqual([60, 120]);
    expect(grid.rows[0]?.cells.map((c) => [c.cumulative, c.net])).toEqual([[100, 100], [170, 70]]);
  });

  it("끊긴 구간에 걸친 다음 관측은 끊김 뒤다", () => {
    const { grid } = appendSnapshots(EMPTY_BROKER_STATE, [feed(60, [["a", 1]]), feed(120, [["a", 2]]), feed(180, [["a", 3]])], [[100, 110]]);
    expect(grid.gapBefore).toEqual([false, true, false]);
  });

  it("축은 장전 자료가 있어도 09:00부터이고 마감 직후 자료로 20:00까지 늘지 않는다", () => {
    expect(boardAxis([kst("08:10:00"), kst("14:19:00")], kst("14:20:00"))).toEqual({ from: kst("09:00:00"), to: kst("14:20:00") });
    expect(boardAxis([kst("08:10:00"), kst("15:30:10")], kst("16:00:00"))).toEqual({ from: kst("09:00:00"), to: kst("15:30:00") });
    expect(boardAxis([kst("09:10:00"), kst("15:45:00")], kst("16:00:00"))).toEqual({ from: kst("09:00:00"), to: kst("16:00:00") });
  });

  it("커서 시각의 가격은 그 시각이 든 분봉의 종가다", () => {
    const bars = [bar(60, 100), bar(120, 110), bar(180, 120)];
    expect([59, 60, 150, 500].map((t) => priceAt(bars, t))).toEqual([null, 100, 110, 120]);
  });
});
