import { expect, test } from "vitest";
import { colorsFrom, firstUnusedColor, isFinancial, isFlow, isForeignFlow, isInstitutionFlow, isInvestorFlow, isMicro, isProgramFlow, isQuote, isQuoteDepth, isQuoteTotals, isTechnical, isTickCvd, KIND_ORDER, KINDS, lineColor, colorLine, placementsOf, shownColor, specLines, specName, nameParts } from "./kinds";

test("기본값은 backend.md §9.5 표를 따른다", () => {
  expect(KIND_ORDER.map((k) => KINDS[k].defaults)).toEqual([
    { kind: "ma", method: "sma", period: 20 },
    { kind: "bollinger", period: 20, k: 2 },
    { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 },
    { kind: "anchoredVwap", priceSource: "hlc3", showBands: true, anchorPreset: "open", anchorTime: null },
    { kind: "volumeProfile", mode: "vrvp", bins: 32, showDelta: true, valueAreaPct: 70 },
    { kind: "volume", maPeriod: 20 },
    { kind: "rsi", period: 14, signal: null },
    { kind: "macd", fast: 12, slow: 26, signal: 9 },
    { kind: "stochSlow", k: 5, d: 3, smooth: 3 },
    { kind: "tickCvd", showWhale: true, showLarge: false, showMid: false, showRetail: true },
    { kind: "tapeVelocity", metric: "tps", showStrength: true },
    { kind: "foreignBrokerFlow", source: "auto", displayMode: "both" },
    { kind: "programFlow", displayMode: "histogram", aggregation: "cumulative", unit: "eok", showShare: false },
    { kind: "foreignFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" },
    { kind: "institutionFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" },
    { kind: "quoteTotals" },
    { kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null, showSpoof: false, showIceberg: false, microLabelMode: "clean", dynamicContrast: true },
    ...["revenue", "operating_income", "owner_roe", "investing_cash_flow", "dps", "debt_ratio"].map((kind) => ({ kind })),
  ]);
  expect(KIND_ORDER.filter((k) => KINDS[k].place === "price")).toEqual(["ma", "bollinger", "ichimoku", "anchoredVwap", "volumeProfile", "quoteDepth"]);
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
  expect(firstUnusedColor(["ind-1", "ind-2", "ind-3", "ind-4", "ind-5"])).toBe("#FFA3AB");
  const rsi = { kind: "rsi", period: 14, signal: 9 } as const;
  expect(lineColor(rsi, ["ind-5"], 1)).toBe("ind-1");
  expect(colorsFrom({ kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 }, "ind-4")).toEqual(["ind-4", "ind-5", "ind-1", "ind-2", "ind-3"]);
});

test("총잔량은 호가지표이고 선 둘을 아래 패널에 그린다", () => {
  const spec = { kind: "quoteTotals" } as const;
  expect(KINDS.quoteTotals.label).toBe("총잔량");
  expect(specName(spec)).toBe("총잔량");
  expect(specLines(spec)).toEqual(["quoteAsk", "quoteBid"]);
  expect(colorLine(spec)).toBeNull();
  expect(KINDS.quoteTotals.fields).toEqual([]);
  expect(placementsOf("quoteTotals")).toEqual(["panel"]);
  expect([isQuote(spec), isTechnical(spec), isFinancial(spec)]).toEqual([true, false, false]);
  expect([isQuote({ kind: "dps" }), isTechnical({ kind: "dps" }), isTechnical({ kind: "volume", maPeriod: null })]).toEqual([false, false, true]);
});

test("히트맵은 가격 패널의 호가지표다", () => {
  const spec = KINDS.quoteDepth.defaults;
  expect(KINDS.quoteDepth.label).toBe("호가 잔량 히트맵");
  expect(specName(spec)).toBe("호가 잔량 히트맵");
  expect(spec).toEqual({ kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null, showSpoof: false, showIceberg: false, microLabelMode: "clean", dynamicContrast: true });
  expect(specLines(spec)).toEqual([]);
  expect(colorLine(spec)).toBeNull();
  expect(placementsOf("quoteDepth")).toEqual(["price"]);
  expect([isQuote(spec), isQuoteDepth(spec), isQuoteTotals(spec), isTechnical(spec)]).toEqual([true, true, false, false]);
  expect([isQuoteDepth({ kind: "quoteTotals" }), isQuoteTotals({ kind: "quoteTotals" })]).toEqual([false, true]);
  expect(KINDS.quoteDepth.fields.map((field) => [field.key, field.label, field.type])).toEqual([
    ["source", "잔량 기준", "choice"],
    ["topLevels", "가격대 수", "optionalInt"],
    ["maxOpacity", "최대 불투명도", "percent"],
    ["dynamicContrast", "동적 대비 (Log + p95)", "flag"],
    ["aboveBars", "봉 앞에 그리기", "flag"],
    ["showSpoof", "허수 취소 표시", "flag"],
    ["showIceberg", "아이스버그 흡수 표시", "flag"],
    ["microLabelMode", "미시 표기 방식", "choice"],
    ["askColor", "매도 색", "color"],
    ["bidColor", "매수 색", "color"],
  ]);
  expect(KINDS.quoteDepth.fields[0]).toMatchObject({ options: [["priceMax", "가격대마다 최댓값"], ["peak", "총잔량 최대 순간"], ["close", "종가 호가"]] });
});

test("계층별 CVD와 프로그램 수급은 아래 패널의 미세 수급 지표다", () => {
  const cvd = KINDS.tickCvd.defaults;
  expect(KINDS.tickCvd.label).toBe("계층별 CVD");
  expect(specName(cvd)).toBe("계층별 CVD");
  expect(specLines(cvd)).toEqual(["cvdWhale", "cvdRetail"]);
  expect(specLines({ kind: "tickCvd", showWhale: true, showLarge: true, showMid: true, showRetail: true })).toEqual([
    "cvdWhale",
    "cvdLarge",
    "cvdMid",
    "cvdRetail",
  ]);
  expect(placementsOf("tickCvd")).toEqual(["panel"]);
  expect([isMicro(cvd), isTickCvd(cvd), isProgramFlow(cvd), isTechnical(cvd)]).toEqual([true, true, false, false]);

  const prog = KINDS.programFlow.defaults;
  expect(KINDS.programFlow.label).toBe("프로그램 수급");
  expect(specName(prog)).toBe("프로그램 수급");
  expect(specLines(prog)).toEqual(["flowBar"]);
  expect(specLines({ ...prog, displayMode: "line" })).toEqual(["flowLine"]);
  expect(specLines({ ...prog, displayMode: "both" })).toEqual(["flowBar", "flowCum"]);
  expect(specLines({ ...prog, showShare: true })).toEqual(["flowBar", "programShare"]);
  expect(colorLine(prog)).toBeNull();
  expect(colorLine({ ...prog, showShare: true })).toBe(1);
  expect(colorLine({ ...prog, displayMode: "line" })).toBe(0);
  expect(colorLine({ ...prog, displayMode: "both" })).toBe(1);
  expect(placementsOf("programFlow")).toEqual(["panel"]);
  expect([isMicro(prog), isFlow(prog), isProgramFlow(prog), isInvestorFlow(prog), isTechnical(prog)]).toEqual([true, true, true, false, false]);

  const foreign = KINDS.foreignFlow.defaults;
  const inst = KINDS.institutionFlow.defaults;
  expect(KINDS.foreignFlow.label).toBe("외국인 순매수");
  expect(KINDS.institutionFlow.label).toBe("기관 순매수");
  expect(specLines(foreign)).toEqual(["flowBar"]);
  expect(specLines({ ...inst, displayMode: "both" })).toEqual(["flowBar", "flowCum"]);
  expect([isInvestorFlow(foreign), isForeignFlow(foreign), isInstitutionFlow(foreign), isFlow(foreign), isTechnical(foreign), isMicro(foreign)]).toEqual([true, true, false, true, false, false]);
  expect([isInvestorFlow(inst), isInstitutionFlow(inst), isForeignFlow(inst), isFlow(inst), isTechnical(inst)]).toEqual([true, true, false, true, false]);
});

test("이름 끝의 숫자 설정값은 필드 순서의 토큰으로 나누고, 숫자로 끝나지 않는 이름은 그대로 둔다", () => {
  expect(nameParts({ kind: "ma", method: "sma", period: 20 })).toEqual({ head: "이동평균 단순", tokens: [{ key: "period", text: "20" }] });
  expect(nameParts({ kind: "bollinger", period: 20, k: 2 })).toEqual({ head: "볼린저 밴드", tokens: [{ key: "period", text: "20" }, { key: "k", text: "2" }] });
  expect(nameParts({ kind: "rsi", period: 14, signal: null })).toEqual({ head: "RSI", tokens: [{ key: "period", text: "14" }] });
  expect(nameParts({ kind: "rsi", period: 14, signal: 9 }).tokens.map((token) => token.key)).toEqual(["period", "signal"]);
  expect(nameParts({ kind: "volume", maPeriod: 20 })).toEqual({ head: "거래량", tokens: [] });
  expect(nameParts({ kind: "revenue" })).toEqual({ head: "매출액", tokens: [] });
});
