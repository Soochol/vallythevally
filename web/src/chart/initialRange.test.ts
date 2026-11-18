import type { IRange } from "lightweight-charts";
import { describe, expect, test } from "vitest";
import type { Bar } from "../api/generated/Bar";
import { InitialRange, initialRangeOf, RIGHT_OFFSET, type RangeScale } from "./initialRange";
import { toChartTime } from "./time";

const bars = (n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000 + i * 86_400, o: 1, h: 1, l: 1, c: 1, v: 1 }));

function setup(n = 300) {
  const calls: string[] = [];
  let host = { width: 800, height: 400 };
  let range: IRange<number> | null = null;
  let onRange: (r: IRange<number> | null) => void = () => {};
  const scale: RangeScale = {
    timeToIndex: (t) => (n === 0 ? null : (Number(t) - Number(toChartTime(1_700_000_000))) / 86_400) as ReturnType<RangeScale["timeToIndex"]>,
    setVisibleLogicalRange: (r) => { range = r as IRange<number>; calls.push(`range ${r.from}..${r.to}`); onRange(range); },
    applyOptions: (o) => { calls.push(`lock ${String(o.lockVisibleTimeRangeOnResize)}`); },
  };
  const initial = new InitialRange(() => scale, () => host);
  onRange = (r) => initial.rangeChanged(r);
  return { initial, calls, resize: (w: number, h: number) => { host = { width: w, height: h }; initial.hostResized(); }, range: () => range };
}

describe("the first visible range", () => {
  test.each([
    ["desktop shows the last 130 bars and the right offset", { visibleBars: null, narrow: false, period: "D" as const }, { from: 170, to: 299 + RIGHT_OFFSET }],
    ["phone shows the last 90 bars", { visibleBars: null, narrow: true, period: "D" as const }, { from: 210, to: 299 + RIGHT_OFFSET }],
    ["a chosen visible bar count wins", { visibleBars: 50, narrow: true, period: "D" as const }, { from: 250, to: 299 + RIGHT_OFFSET }],
    ["yearly shows every bar", { visibleBars: null, narrow: false, period: "Y" as const }, { from: -0.5, to: 299.5 + 2 }],
  ])("%s", (_, input, expected) => {
    expect(initialRangeOf({ bars: bars(300), ...input }, 0, 299)).toEqual(expected);
  });

  test("a zero right offset puts the end bar on the right edge", () => {
    expect(initialRangeOf({ bars: bars(300), visibleBars: 50, narrow: false, period: "D", rightOffset: 0 }, 0, 299)).toEqual({ from: 250, to: 299 });
  });
});

describe("holding the first range", () => {
  test("fitting locks the range against resizes and its own range change does not release it", () => {
    const { initial, calls } = setup();
    initial.fit({ bars: bars(300), period: "D", visibleBars: null, narrow: false });
    expect(calls).toEqual(["lock true", `range 170..${299 + RIGHT_OFFSET}`]);
    expect(initial.held).toBe(true);
  });

  test("a range drift under a thousandth keeps the hold, a real move releases and unlocks", () => {
    const { initial, calls } = setup();
    initial.fit({ bars: bars(300), period: "D", visibleBars: null, narrow: false });
    initial.rangeChanged({ from: 170.0005, to: 299 + RIGHT_OFFSET });
    expect(initial.held).toBe(true);
    initial.rangeChanged({ from: 160, to: 299 + RIGHT_OFFSET });
    expect(initial.held).toBe(false);
    expect(calls.at(-1)).toBe("lock false");
  });

  test("the host changing size releases, the same size keeps the hold", () => {
    const { initial, resize } = setup();
    initial.fit({ bars: bars(300), period: "D", visibleBars: null, narrow: false });
    resize(800, 400);
    expect(initial.held).toBe(true);
    resize(800, 380);
    expect(initial.held).toBe(false);
  });

  test("without bars there is nothing to hold", () => {
    const { initial, calls } = setup(0);
    initial.fit({ bars: [], period: "D", visibleBars: null, narrow: false });
    initial.release();
    expect([initial.held, calls]).toEqual([false, []]);
  });

  test("forgetting drops the hold without touching the chart", () => {
    const { initial, calls } = setup();
    initial.fit({ bars: bars(300), period: "D", visibleBars: null, narrow: false });
    initial.forget();
    expect([initial.held, calls.length]).toEqual([false, 2]);
  });
});
