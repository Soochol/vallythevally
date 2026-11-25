import { describe, expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { ProgramSeriesPoint } from "../../api/generated/ProgramSeriesPoint";
import type { TickCvdPoint } from "../../api/generated/TickCvdPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { IndicatorConfig } from "../settings";
import type { ThemeTokens } from "../theme";
import {
  applyLiveProgramToPoints,
  applyLiveTradeToPoints,
  bucketStartSec,
  classifyTickTier,
  formatMillionWon,
  formatSharePct,
  MicroIndicatorController,
} from "./microFamily";

const TOKENS = {
  chartBg: "#000000",
  text: "#ffffff",
  text2: "#aaaaaa",
  text3: "#888888",
  line: "#333333",
  grid: "#222222",
  gridH: "#222222",
  raised: "#111111",
  onData: "#ffffff",
  accent: "#00ff00",
  crosshair: "#666666",
  up: "#ff0000",
  down: "#0000ff",
  upVol: "#ff0000",
  downVol: "#0000ff",
  seriesLine: "#ffffff",
  seriesFill: "#ffffff",
  fontFamily: "sans-serif",
  fontSize: 12,
  ind: { "ind-1": "#111111", "ind-2": "#222222", "ind-3": "#333333", "ind-4": "#444444", "ind-5": "#555555" },
  cmp: { 1: "#111111", 2: "#222222", 3: "#333333" },
} satisfies ThemeTokens;

const CVD_CONFIG: IndicatorConfig = {
  id: "cvd",
  spec: { kind: "tickCvd", showWhale: true, showLarge: false, showMid: false, showRetail: true },
  panel: "p-cvd",
  visible: true,
  style: { colors: ["ind-1", "ind-2"], width: 1 },
};

const PROGRAM_CONFIG: IndicatorConfig = {
  id: "prog",
  spec: { kind: "programFlow", showShare: false },
  panel: "p-prog",
  visible: true,
  style: { colors: ["ind-3"], width: 1 },
};

describe("classifyTickTier", () => {
  test("matches exact KRW boundaries from backend", () => {
    expect(classifyTickTier(0)).toBe("retail");
    expect(classifyTickTier(4_999_999)).toBe("retail");
    expect(classifyTickTier(5_000_000)).toBe("mid");
    expect(classifyTickTier(29_999_999)).toBe("mid");
    expect(classifyTickTier(30_000_000)).toBe("large");
    expect(classifyTickTier(99_999_999)).toBe("large");
    expect(classifyTickTier(100_000_000)).toBe("whale");
    expect(classifyTickTier(250_000_000)).toBe("whale");
  });
});

describe("live bar parity", () => {
  const day1Open = Math.floor(Date.parse("2026-11-23T09:00:00+09:00") / 1000);
  const day2Open = Math.floor(Date.parse("2026-11-24T09:00:00+09:00") / 1000);

  test("bucketStartSec aligns intraday timestamps and rejects daily", () => {
    expect(bucketStartSec(day1Open + 42, "1m")).toBe(day1Open);
    expect(bucketStartSec(day1Open + 299, "5m")).toBe(day1Open);
    expect(bucketStartSec(day1Open + 300, "5m")).toBe(day1Open + 300);
    expect(bucketStartSec(day1Open, "D")).toBeNull();
  });

  test("applyLiveTradeToPoints accumulates same day and resets next day", () => {
    const map = new Map<UnixSeconds, TickCvdPoint>();
    map.set(day1Open, {
      t: day1Open,
      whaleNetMillionWon: 150,
      largeNetMillionWon: 0,
      midNetMillionWon: 0,
      retailNetMillionWon: -20,
    });

    const sameBar = applyLiveTradeToPoints(
      map,
      { t: day1Open + 35, price: 100_000, qty: 1_200, venue: "krx", strength: null },
      "1m",
    );
    expect(sameBar?.t).toBe(day1Open);
    expect(sameBar?.whaleNetMillionWon).toBeCloseTo(270, 6);
    expect(sameBar?.retailNetMillionWon).toBeCloseTo(-20, 6);

    const nextMinute = applyLiveTradeToPoints(
      map,
      { t: day1Open + 70, price: 10_000, qty: -300, venue: "krx", strength: null },
      "1m",
    );
    expect(nextMinute?.t).toBe(day1Open + 60);
    expect(nextMinute?.whaleNetMillionWon).toBeCloseTo(270, 6);
    expect(nextMinute?.retailNetMillionWon).toBeCloseTo(-23, 6);

    const nextDay = applyLiveTradeToPoints(
      map,
      { t: day2Open + 5, price: 100_000, qty: -1_000, venue: "krx", strength: null },
      "1m",
    );
    expect(nextDay?.t).toBe(day2Open);
    expect(nextDay?.whaleNetMillionWon).toBeCloseTo(-100, 6);
    expect(nextDay?.retailNetMillionWon).toBeCloseTo(0, 6);
  });

  test("applyLiveProgramToPoints updates active bucket without refetch", () => {
    const map = new Map<UnixSeconds, ProgramSeriesPoint>();
    const pt = applyLiveProgramToPoints(
      map,
      {
        t: day1Open + 18,
        price: 70_000,
        sellQty: 100,
        sellAmount: 40,
        buyQty: 300,
        buyAmount: 120,
        netQty: 200,
        netQtyChange: 50,
        netAmount: 80,
        netAmountChange: 20,
      },
      "1m",
      400_000_000,
    );
    expect(pt).toEqual({
      t: day1Open,
      netBuyAmountMillionWon: 80,
      netBuyQty: 200,
      buyAmountMillionWon: 120,
      sellAmountMillionWon: 40,
      programSharePct: 40,
    });
  });

  test("formatters render Korean units cleanly", () => {
    expect(formatMillionWon(150)).toBe("+1.50억");
    expect(formatMillionWon(-30)).toBe("−30백만");
    expect(formatMillionWon(0)).toBe("0백만");
    expect(formatSharePct(18.54)).toBe("18.5%");
    expect(formatSharePct(null)).toBe("—");
  });
});

describe("MicroIndicatorController", () => {
  test("updates live WS frames in-place without redundant HTTP fetches and shows clean unsupported message on daily", async () => {
    const t0 = Math.floor(Date.parse("2026-11-24T09:00:00+09:00") / 1000);
    const bars: Bar[] = [{ t: t0, o: 70000, h: 70500, l: 69900, c: 70200, v: 1000 }];
    let cvdCalls = 0;
    let programCalls = 0;
    let cvdChanged = 0;
    let programChanged = 0;
    const ctl = new MicroIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [CVD_CONFIG, PROGRAM_CONFIG],
        onTickCvdChanged: () => { cvdChanged++; },
        onProgramChanged: () => { programChanged++; },
      },
      {
        fetchTickCvd: async () => {
          cvdCalls++;
          return {
            symbol: "005930",
            period: "1m",
            state: "ready",
            points: [{ t: t0, whaleNetMillionWon: 100, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: -10 }],
          };
        },
        fetchProgramSeries: async () => {
          programCalls++;
          return {
            symbol: "005930",
            period: "1m",
            state: "ready",
            points: [{ t: t0, netBuyAmountMillionWon: 200, netBuyQty: 2500, buyAmountMillionWon: 300, sellAmountMillionWon: 100, programSharePct: 25 }],
          };
        },
      },
    );

    ctl.setTarget({ symbol: "005930", period: "1m" });
    await Promise.resolve();
    await Promise.resolve();

    expect(cvdCalls).toBe(1);
    expect(programCalls).toBe(1);
    expect(ctl.tickCvdRow(CVD_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["초대형 +1.00억", "소형 −10백만"]);
    expect(ctl.programFlowRow(PROGRAM_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["순매수 +2.00억"]);

    expect(ctl.applyLiveTrade("005930", { t: t0 + 12, price: 100_000, qty: 1_500, venue: "krx", strength: null })).toBe(true);
    expect(ctl.applyLiveProgram("005930", { t: t0 + 15, price: 70_200, sellQty: 100, sellAmount: 100, buyQty: 400, buyAmount: 450, netQty: 3000, netQtyChange: 500, netAmount: 350, netAmountChange: 150 })).toBe(true);
    expect(cvdCalls).toBe(1);
    expect(programCalls).toBe(1);
    expect(cvdChanged).toBeGreaterThan(0);
    expect(programChanged).toBeGreaterThan(0);
    expect(ctl.tickCvdRow(CVD_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["초대형 +2.50억", "소형 −10백만"]);
    expect(ctl.programFlowRow(PROGRAM_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["순매수 +3.50억"]);

    ctl.setTarget({ symbol: "005930", period: "D" });
    expect(cvdCalls).toBe(1);
    expect(programCalls).toBe(1);
    expect(ctl.tickCvdRow(CVD_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 분봉 전용"]);
    expect(ctl.programFlowRow(PROGRAM_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 분봉 전용"]);
    ctl.dispose();
  });
});
