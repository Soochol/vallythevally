import { expect, test } from "vitest";
import { colorsFrom, firstUnusedColor, KIND_ORDER, KINDS, lineColor, colorLine, shownColor, specLines, specName } from "./kinds";

test("기본값은 backend.md §9.5 표를 따른다", () => {
  expect(KIND_ORDER.map((k) => KINDS[k].defaults)).toEqual([
    { kind: "ma", method: "sma", period: 20 },
    { kind: "bollinger", period: 20, k: 2 },
    { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 },
    { kind: "volume", maPeriod: 20 },
    { kind: "rsi", period: 14, signal: null },
    { kind: "macd", fast: 12, slow: 26, signal: 9 },
    { kind: "stochSlow", k: 5, d: 3, smooth: 3 },
  ]);
  expect(KIND_ORDER.filter((k) => KINDS[k].place === "price")).toEqual(["ma", "bollinger", "ichimoku"]);
});

test("이름에 설정값을 붙인다", () => {
  expect(specName({ kind: "ma", method: "ema", period: 60 })).toBe("이동평균 지수 60");
  expect(specName({ kind: "bollinger", period: 20, k: 2 })).toBe("볼린저 밴드 20 2");
  expect(specName({ kind: "rsi", period: 14, signal: 9 })).toBe("RSI 14 9");
});

test("거래량은 막대 말고 이동평균 선이 색을 고른다", () => {
  const vol = { kind: "volume", maPeriod: 20 } as const;
  expect(specLines(vol)).toEqual(["volume", "ma"]);
  expect(colorLine(vol)).toBe(1);
  expect(colorLine({ kind: "volume", maPeriod: null })).toBeNull();
  expect(colorsFrom(vol, "ind-3")).toEqual(["ind-2", "ind-3"]);
  expect(shownColor(vol, colorsFrom(vol, "ind-3"))).toBe("ind-3");
});

test("안 쓴 첫 색, 선이 늘어나면 대표 색에서 이어 칠한다", () => {
  expect(firstUnusedColor(["ind-1", "ind-3"])).toBe("ind-2");
  expect(firstUnusedColor(["ind-1", "ind-2", "ind-3", "ind-4", "ind-5"])).toBe("ind-1");
  const rsi = { kind: "rsi", period: 14, signal: 9 } as const;
  expect(lineColor(rsi, ["ind-5"], 1)).toBe("ind-1");
  expect(colorsFrom({ kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 }, "ind-4")).toEqual(["ind-4", "ind-5", "ind-1", "ind-2", "ind-3"]);
});
