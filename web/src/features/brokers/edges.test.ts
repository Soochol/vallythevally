import { describe, expect, it } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import { axisGapRanges, dayBars, priceAt } from "./history";
import { EMPTY_BROKER_STATE, appendSnapshots } from "./model";

const entry = (code: string, qty: number) => ({ code, name: `사${code}`, qty, qtyChange: 0 });
const feed = (t: number, buys: [string, number][], sells: [string, number][] = []): FeedBrokers => ({
  t,
  buys: buys.map(([c, q]) => entry(c, q)),
  sells: sells.map(([c, q]) => entry(c, q)),
});
const kst = (day: string, clock: string) => Date.parse(`${day}T${clock}+09:00`) / 1000;
const bar = (t: number, close: number): Bar => ({ t, o: close, h: close, l: close, c: close, v: 1 });

describe("거래원 수집 자료 경계", () => {
  it("그날 밖의 분봉은 가격이 되지 않는다", () => {
    const bars = [bar(kst("2026-11-23", "15:30:00"), 65_000), bar(kst("2026-11-24", "09:03:00"), 71_300)];
    const filtered = dayBars(bars, "20261124");
    expect([kst("2026-11-24", "09:01:00"), kst("2026-11-24", "09:03:00")].map((t) => priceAt(filtered, t))).toEqual([null, 71_300]);
  });

  it("같은 초의 교체에서 빠진 거래원은 남지 않는다", () => {
    const first = feed(120, [["a", 100], ["b", 50]]);
    const second = feed(120, [["a", 120]]);
    const twoSteps = appendSnapshots(appendSnapshots(EMPTY_BROKER_STATE, [first], []), [second], []);
    const oneStep = appendSnapshots(EMPTY_BROKER_STATE, [first, second], []);
    expect(twoSteps.grid).toEqual(oneStep.grid);
    expect(twoSteps.grid.rows.map((row) => row.code)).toEqual(["a"]);
  });

  it("09:00 전 끊김은 빗금이 없다", () => {
    const axis = { from: kst("2026-11-24", "09:00:00"), to: kst("2026-11-24", "10:00:00") };
    const ranges = axisGapRanges(
      [
        [kst("2026-11-24", "08:00:00"), kst("2026-11-24", "08:05:00")],
        [kst("2026-11-24", "08:55:00"), kst("2026-11-24", "09:10:00")],
      ],
      axis,
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.left).toBeCloseTo(0, 5);
    expect(ranges[0]!.width).toBeCloseTo((10 / 60) * 100, 5);
  });
});
