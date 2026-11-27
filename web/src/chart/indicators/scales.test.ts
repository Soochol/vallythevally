import { expect, test } from "vitest";
import type { IndicatorConfig } from "../settings";
import { axisSlotLabel, nextIndicatorAxis, priceScaleIdFor, resolvePanelScales, scaleDomainOf } from "./scales";

const style = { colors: ["ind-1" as const], width: 1 as const };
const config = (id: string, spec: IndicatorConfig["spec"], axis?: IndicatorConfig["axis"]): IndicatorConfig => ({
  id,
  spec,
  panel: "p1",
  visible: true,
  style,
  ...(axis ? { axis } : {}),
});

const PROG_BAR = { kind: "programFlow", displayMode: "histogram", aggregation: "bar", unit: "eok", showShare: false } as const;
const PROG_CUM = { kind: "programFlow", displayMode: "histogram", aggregation: "cumulative", unit: "eok", showShare: false } as const;
const FOREIGN_BAR = { kind: "foreignFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" } as const;
const INST_BAR = { kind: "institutionFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" } as const;
const INST_CUM = { kind: "institutionFlow", displayMode: "line", aggregation: "cumulative", unit: "eok" } as const;
const INST_SHARES = { kind: "institutionFlow", displayMode: "histogram", aggregation: "bar", unit: "shares" } as const;

test("지표 종류별 스케일 도메인을 분류한다", () => {
  expect(scaleDomainOf({ kind: "rsi", period: 14, signal: null })).toBe("bound_0_100");
  expect(scaleDomainOf({ kind: "stochSlow", k: 5, d: 3, smooth: 3 })).toBe("bound_0_100");
  expect(scaleDomainOf({ kind: "volume", maPeriod: 20 })).toBe("volume");
  expect(scaleDomainOf({ kind: "quoteTotals" })).toBe("volume");
  expect(scaleDomainOf({ kind: "macd", fast: 12, slow: 26, signal: 9 })).toBe("oscillator_zero");
  expect(scaleDomainOf(PROG_BAR)).toBe("flow_won");
  expect(scaleDomainOf(PROG_CUM)).toBe("flow_won_cum");
  expect(scaleDomainOf(FOREIGN_BAR)).toBe("flow_won");
  expect(scaleDomainOf({ ...FOREIGN_BAR, displayMode: "both", aggregation: "cumulative" })).toBe("flow_won");
  expect(scaleDomainOf(INST_SHARES)).toBe("flow_shares");
  expect(scaleDomainOf({ ...INST_SHARES, aggregation: "cumulative" })).toBe("flow_shares_cum");
  expect(scaleDomainOf({ kind: "tickCvd", showWhale: true, showLarge: false, showMid: false, showRetail: false })).toBe("flow_won_cum");
  expect(scaleDomainOf({ kind: "owner_roe" })).toBe("percent");
  expect(scaleDomainOf({ kind: "revenue" })).toBe("financial_won");
});

test("같은 스케일 도메인은 우측 축을 공유하고 이질적 지표는 우측·좌측·독립 순으로 배정한다", () => {
  const sameDomain = resolvePanelScales([
    config("rsi", { kind: "rsi", period: 14, signal: null }),
    config("stoch", { kind: "stochSlow", k: 5, d: 3, smooth: 3 }),
  ], "p1");
  expect(sameDomain.get("rsi")?.slot).toBe("right");
  expect(sameDomain.get("stoch")?.slot).toBe("right");

  const sameFlow = resolvePanelScales([
    config("foreign", FOREIGN_BAR),
    config("inst", INST_BAR),
  ], "p1");
  expect(sameFlow.get("foreign")?.slot).toBe("right");
  expect(sameFlow.get("inst")?.slot).toBe("right");

  const splitFlowCum = resolvePanelScales([
    config("foreign", FOREIGN_BAR),
    config("inst", INST_CUM),
  ], "p1");
  expect(splitFlowCum.get("foreign")?.slot).toBe("right");
  expect(splitFlowCum.get("inst")?.slot).toBe("left");

  const splitFlowShares = resolvePanelScales([
    config("foreign", FOREIGN_BAR),
    config("inst", INST_SHARES),
  ], "p1");
  expect(splitFlowShares.get("foreign")?.slot).toBe("right");
  expect(splitFlowShares.get("inst")?.slot).toBe("left");

  const mixed = resolvePanelScales([
    config("vol", { kind: "volume", maPeriod: 20 }),
    config("rsi", { kind: "rsi", period: 14, signal: null }),
    config("prog", PROG_BAR),
  ], "p1");
  expect(mixed.get("vol")?.slot).toBe("right");
  expect(mixed.get("rsi")?.slot).toBe("left");
  expect(mixed.get("prog")?.slot).toBe("overlay");
  expect(priceScaleIdFor(config("prog", PROG_BAR), "overlay")).toBe("overlay:prog");
});

test("명시적 축 지정을 우선 반영하고 순환 헬퍼는 R→L→독립→R로 돈다", () => {
  const explicit = resolvePanelScales([
    config("vol", { kind: "volume", maPeriod: 20 }),
    config("rsi", { kind: "rsi", period: 14, signal: null }, "right"),
    config("prog", PROG_BAR, "left"),
  ], "p1");
  expect(explicit.get("rsi")).toMatchObject({ slot: "right", explicit: true });
  expect(explicit.get("prog")).toMatchObject({ slot: "left", explicit: true });
  expect(explicit.get("vol")).toMatchObject({ slot: "overlay", explicit: false });

  expect(nextIndicatorAxis("right")).toBe("left");
  expect(nextIndicatorAxis("left")).toBe("overlay");
  expect(nextIndicatorAxis("overlay")).toBe("right");
  expect([axisSlotLabel("right"), axisSlotLabel("left"), axisSlotLabel("overlay")]).toEqual(["R", "L", "독립"]);
});
