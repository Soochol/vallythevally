import { describe, expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { ProgramSeriesPage } from "../../api/generated/ProgramSeriesPage";
import type { ProgramSeriesPoint } from "../../api/generated/ProgramSeriesPoint";
import type { TickCvdPage } from "../../api/generated/TickCvdPage";
import type { TickCvdPoint } from "../../api/generated/TickCvdPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { MicroRange } from "../../api/microSeries";
import { kstDateOf } from "../barJump";
import { MAX_RANGE_DAYS } from "../quotes/coverage";
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
import { validateNonTechnicalSpec } from "./validate";

const TOKENS = {
  chartBg: "#000000",
  text: "#ffffff",
  text2: "#aaaaaa",
  text3: "#888888",
  line: "#333333",
  grid: "#222222",
  gridH: "#222222",
  daySeparator: "rgba(255, 255, 255, 0.15)",
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
  spec: { kind: "programFlow", displayMode: "histogram", aggregation: "cumulative", unit: "eok", showShare: false },
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
    await Promise.resolve();
    await Promise.resolve();
    expect(cvdCalls).toBe(1);
    expect(programCalls).toBe(2);
    expect(ctl.tickCvdRow(CVD_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 분봉 전용"]);
    expect(ctl.programFlowRow(PROGRAM_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["순매수 +2.00억"]);

    ctl.setTarget({ symbol: "IDX:001", period: "D" });
    expect(ctl.tickCvdRow(CVD_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 분봉 전용"]);
    expect(ctl.programFlowRow(PROGRAM_CONFIG, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 전용"]);
    ctl.dispose();
  });

  test("splits >31-day 60m initial loads into <=31-day chunks and reaches ready", async () => {
    const startSec = Math.floor(Date.parse("2026-09-15T09:00:00+09:00") / 1000);
    const endSec = Math.floor(Date.parse("2026-11-24T15:00:00+09:00") / 1000);
    const bars: Bar[] = [
      { t: startSec, o: 70000, h: 70500, l: 69900, c: 70200, v: 1000 },
      { t: endSec, o: 71000, h: 71500, l: 70900, c: 71200, v: 1000 },
    ];
    const cvdRanges: MicroRange[] = [];
    const programRanges: MicroRange[] = [];
    const spanDays = (range: MicroRange) => {
      const fromDay = Date.parse(`${kstDateOf(range.from!)}T00:00:00Z`) / 86_400_000;
      const toDay = Date.parse(`${kstDateOf(range.to!)}T00:00:00Z`) / 86_400_000;
      return toDay - fromDay + 1;
    };

    const ctl = new MicroIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [CVD_CONFIG, PROGRAM_CONFIG],
        onTickCvdChanged: () => {},
        onProgramChanged: () => {},
      },
      {
        fetchTickCvd: async (_symbol, period, range) => {
          cvdRanges.push(range);
          expect(spanDays(range)).toBeLessThanOrEqual(MAX_RANGE_DAYS);
          const pts: TickCvdPoint[] = [];
          if (range.from! <= startSec && startSec <= range.to!) {
            pts.push({ t: startSec, whaleNetMillionWon: 12, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: -2 });
          }
          if (range.from! <= endSec && endSec <= range.to!) {
            pts.push({ t: endSec, whaleNetMillionWon: 88, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: -5 });
          }
          return { symbol: "005930", period, state: "ready", points: pts };
        },
        fetchProgramSeries: async (_symbol, period, range) => {
          programRanges.push(range);
          expect(spanDays(range)).toBeLessThanOrEqual(MAX_RANGE_DAYS);
          const pts: ProgramSeriesPoint[] = [];
          if (range.from! <= startSec && startSec <= range.to!) {
            pts.push({ t: startSec, netBuyAmountMillionWon: 30, netBuyQty: 300, buyAmountMillionWon: 40, sellAmountMillionWon: 10, programSharePct: 15, dayTradedMillionWon: 333.3 });
          }
          if (range.from! <= endSec && endSec <= range.to!) {
            pts.push({ t: endSec, netBuyAmountMillionWon: 90, netBuyQty: 900, buyAmountMillionWon: 120, sellAmountMillionWon: 30, programSharePct: 20, dayTradedMillionWon: 750 });
          }
          return { symbol: "005930", period, state: "ready", points: pts };
        },
      },
    );

    ctl.setTarget({ symbol: "005930", period: "60m" });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(cvdRanges.length).toBe(3);
    expect(programRanges.length).toBe(3);
    expect(ctl.cvdState()).toBe("ready");
    expect(ctl.programState()).toBe("ready");
    expect(ctl.cvdPointAt(startSec)?.whaleNetMillionWon).toBe(12);
    expect(ctl.cvdPointAt(endSec)?.whaleNetMillionWon).toBe(88);
    expect(ctl.programPointAt(startSec)?.netBuyAmountMillionWon).toBe(30);
    expect(ctl.programPointAt(endSec)?.netBuyAmountMillionWon).toBe(90);
    ctl.dispose();
  });

  test("continues fetching pan-left ranges queued while an earlier fetch is in-flight", async () => {
    const tOlder = Math.floor(Date.parse("2026-11-01T09:00:00+09:00") / 1000);
    const tNewer = Math.floor(Date.parse("2026-11-24T09:00:00+09:00") / 1000);
    let bars: Bar[] = [{ t: tNewer, o: 70000, h: 70500, l: 69900, c: 70200, v: 1000 }];
    const pending: { range: MicroRange; resolve: (page: TickCvdPage) => void }[] = [];

    const ctl = new MicroIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [CVD_CONFIG],
        onTickCvdChanged: () => {},
        onProgramChanged: () => {},
      },
      {
        fetchTickCvd: (_symbol, _period, range) =>
          new Promise<TickCvdPage>((resolve) => {
            pending.push({ range, resolve });
          }),
      },
    );

    ctl.setTarget({ symbol: "005930", period: "1m" });
    expect(pending).toHaveLength(1);

    bars = [{ t: tOlder, o: 68000, h: 68500, l: 67900, c: 68200, v: 1000 }, ...bars];
    ctl.cover(bars);
    expect(pending).toHaveLength(1);

    pending[0]!.resolve({
      symbol: "005930",
      period: "1m",
      state: "ready",
      points: [{ t: tNewer, whaleNetMillionWon: 50, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: 0 }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(pending).toHaveLength(2);
    expect(kstDateOf(pending[1]!.range.from!)).toBe("2026-11-01");
    expect(kstDateOf(pending[1]!.range.to!)).toBe("2026-11-23");

    pending[1]!.resolve({
      symbol: "005930",
      period: "1m",
      state: "ready",
      points: [{ t: tOlder, whaleNetMillionWon: 25, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: 0 }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(ctl.cvdPointAt(tOlder)?.whaleNetMillionWon).toBe(25);
    expect(ctl.cvdPointAt(tNewer)?.whaleNetMillionWon).toBe(50);
    ctl.dispose();
  });

  test("seeds mid-day programSharePct from HTTP turnover without tickCvd and avoids 100% spike", async () => {
    const t0 = Math.floor(Date.parse("2026-11-24T13:00:00+09:00") / 1000);
    const bars: Bar[] = [{ t: t0, o: 70000, h: 70500, l: 69900, c: 70200, v: 1000 }];
    const shareConfig: IndicatorConfig = {
      ...PROGRAM_CONFIG,
      spec: { kind: "programFlow", displayMode: "histogram", aggregation: "cumulative", unit: "eok", showShare: true },
    };
    let resolveProgram!: (page: ProgramSeriesPage) => void;

    const ctl = new MicroIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [shareConfig],
        onTickCvdChanged: () => {},
        onProgramChanged: () => {},
      },
      {
        fetchProgramSeries: () =>
          new Promise<ProgramSeriesPage>((resolve) => {
            resolveProgram = resolve;
          }),
      },
    );

    ctl.setTarget({ symbol: "005930", period: "1m" });
    ctl.applyLiveTrade("005930", { t: t0 + 10, price: 100_000, qty: 100, venue: "krx", strength: null });
    ctl.applyLiveProgram("005930", {
      t: t0 + 15,
      price: 70_200,
      sellQty: 2000,
      sellAmount: 300,
      buyQty: 5000,
      buyAmount: 500,
      netQty: 3000,
      netQtyChange: 100,
      netAmount: 200,
      netAmountChange: 20,
    });
    expect(ctl.programPointAt(t0)?.programSharePct).toBeNull();

    resolveProgram({
      symbol: "005930",
      period: "1m",
      state: "ready",
      points: [
        {
          t: t0 - 60,
          netBuyAmountMillionWon: 180,
          netBuyQty: 2900,
          buyAmountMillionWon: 480,
          sellAmountMillionWon: 300,
          programSharePct: 19.55,
          dayTradedMillionWon: 3990,
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(ctl.programPointAt(t0)?.programSharePct).toBeCloseTo(20, 4);
    expect(ctl.programFlowRow(shareConfig, t0, TOKENS, null).values.map((v) => v.text)).toEqual(["순매수 +2.00억", "비중 20.0%"]);

    ctl.applyLiveTrade("005930", { t: t0 + 70, price: 100_000, qty: 10_000, venue: "krx", strength: null });
    ctl.applyLiveProgram("005930", {
      t: t0 + 75,
      price: 70_300,
      sellQty: 2500,
      sellAmount: 400,
      buyQty: 6000,
      buyAmount: 600,
      netQty: 3500,
      netQtyChange: 500,
      netAmount: 200,
      netAmountChange: 0,
    });
    expect(ctl.programPointAt(t0 + 60)?.programSharePct).toBeCloseTo(20, 4);
    ctl.dispose();
  });

  test("preserves in-flight live WS trades, rebases newer live bars onto HTTP baseline, and refetches on invalidateCoverage", async () => {
    const t1 = Math.floor(Date.parse("2026-11-24T10:04:00+09:00") / 1000);
    const t2 = t1 + 60;
    const bars: Bar[] = [
      { t: t1, o: 70000, h: 70500, l: 69900, c: 70200, v: 1000 },
      { t: t2, o: 70200, h: 70600, l: 70100, c: 70400, v: 1000 },
    ];
    const resolvers: ((page: TickCvdPage) => void)[] = [];

    const ctl = new MicroIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [CVD_CONFIG],
        onTickCvdChanged: () => {},
        onProgramChanged: () => {},
      },
      {
        fetchTickCvd: () =>
          new Promise<TickCvdPage>((resolve) => {
            resolvers.push(resolve);
          }),
      },
    );

    ctl.setTarget({ symbol: "005930", period: "1m" });
    expect(resolvers).toHaveLength(1);

    ctl.applyLiveTrade("005930", { t: t1 + 30, price: 100_000, qty: 1_200, venue: "krx", strength: null });
    ctl.applyLiveTrade("005930", { t: t2 + 10, price: 100_000, qty: 1_000, venue: "krx", strength: null });

    resolvers[0]!({
      symbol: "005930",
      period: "1m",
      state: "ready",
      points: [{ t: t1, whaleNetMillionWon: 200, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: -10 }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(ctl.cvdPointAt(t1)?.whaleNetMillionWon).toBeCloseTo(320, 6);
    expect(ctl.cvdPointAt(t1)?.retailNetMillionWon).toBeCloseTo(-10, 6);
    expect(ctl.cvdPointAt(t2)?.whaleNetMillionWon).toBeCloseTo(420, 6);
    expect(ctl.cvdPointAt(t2)?.retailNetMillionWon).toBeCloseTo(-10, 6);

    ctl.invalidateCoverage();
    ctl.cover(bars);
    expect(resolvers).toHaveLength(2);
    resolvers[1]!({
      symbol: "005930",
      period: "1m",
      state: "ready",
      points: [
        { t: t1, whaleNetMillionWon: 320, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: -10 },
        { t: t2, whaleNetMillionWon: 500, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: -15 },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(ctl.cvdPointAt(t2)?.whaleNetMillionWon).toBeCloseTo(500, 6);
    ctl.dispose();
  });

  test("ignores live updates and clears liveLatestT when live is disabled in Jump Mode", async () => {
    const histT = Math.floor(Date.parse("2026-10-15T10:00:00+09:00") / 1000);
    const todayT = Math.floor(Date.parse("2026-11-24T10:00:15+09:00") / 1000);
    const bars: Bar[] = [{ t: histT, o: 65000, h: 65500, l: 64900, c: 65200, v: 1000 }];

    const ctl = new MicroIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [CVD_CONFIG, PROGRAM_CONFIG],
        onTickCvdChanged: () => {},
        onProgramChanged: () => {},
      },
      {
        fetchTickCvd: async () => ({
          symbol: "005930",
          period: "1m",
          state: "ready",
          points: [{ t: histT, whaleNetMillionWon: 75, largeNetMillionWon: 0, midNetMillionWon: 0, retailNetMillionWon: -5 }],
        }),
        fetchProgramSeries: async () => ({
          symbol: "005930",
          period: "1m",
          state: "ready",
          points: [{ t: histT, netBuyAmountMillionWon: 40, netBuyQty: 400, buyAmountMillionWon: 80, sellAmountMillionWon: 40, programSharePct: 12 }],
        }),
      },
    );

    ctl.setTarget({ symbol: "005930", period: "1m" });
    await Promise.resolve();
    await Promise.resolve();

    ctl.setLiveEnabled(false);
    expect(ctl.applyLiveTrade("005930", { t: todayT, price: 100_000, qty: 2_000, venue: "krx", strength: null })).toBe(false);
    expect(
      ctl.applyLiveProgram("005930", {
        t: todayT,
        price: 70_000,
        sellQty: 100,
        sellAmount: 100,
        buyQty: 500,
        buyAmount: 500,
        netQty: 400,
        netQtyChange: 400,
        netAmount: 400,
        netAmountChange: 400,
      }),
    ).toBe(false);
    expect(ctl.cvdLiveLatestT()).toBeNull();
    expect(ctl.programLiveLatestT()).toBeNull();
    expect(ctl.tickCvdRow(CVD_CONFIG, histT, TOKENS, null).values.map((v) => v.text)).toEqual(["초대형 +75백만", "소형 −5백만"]);
    expect(ctl.programFlowRow(PROGRAM_CONFIG, histT, TOKENS, null).values.map((v) => v.text)).toEqual(["순매수 +40백만"]);
    ctl.dispose();
  });

  test("folds [20:00:00, 20:00:10) KST close-grace timestamps into closing bar and rejects empty tickCvd spec", () => {
    const close0 = Math.floor(Date.parse("2026-11-24T20:00:00+09:00") / 1000);
    const close9 = Math.floor(Date.parse("2026-11-24T20:00:09+09:00") / 1000);
    const close10 = Math.floor(Date.parse("2026-11-24T20:00:10+09:00") / 1000);

    expect(bucketStartSec(close0, "1m")).toBe(Math.floor(Date.parse("2026-11-24T19:59:00+09:00") / 1000));
    expect(bucketStartSec(close9, "1m")).toBe(Math.floor(Date.parse("2026-11-24T19:59:00+09:00") / 1000));
    expect(bucketStartSec(close0, "5m")).toBe(Math.floor(Date.parse("2026-11-24T19:55:00+09:00") / 1000));
    expect(bucketStartSec(close9, "60m")).toBe(Math.floor(Date.parse("2026-11-24T19:00:00+09:00") / 1000));
    expect(bucketStartSec(close10, "1m")).toBe(close0);

    expect(
      validateNonTechnicalSpec({ kind: "tickCvd", showWhale: false, showLarge: false, showMid: false, showRetail: false }).ok,
    ).toBe(false);
    expect(
      validateNonTechnicalSpec({ kind: "tickCvd", showWhale: false, showLarge: false, showMid: false, showRetail: true }).ok,
    ).toBe(true);
  });

  test("applyLiveTrades batches notifications and stops buffering pendingLive after fetch failure", async () => {
    const t0 = Math.floor(Date.parse("2026-11-24T09:05:00+09:00") / 1000);
    const bars: Bar[] = [{ t: t0, o: 100, h: 101, l: 99, c: 100, v: 1000 }];
    let cvdChangedCalls = 0;
    const ctl = new MicroIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [CVD_CONFIG],
        onTickCvdChanged: () => { cvdChangedCalls++; },
        onProgramChanged: () => {},
      },
      {
        fetchTickCvd: async () => Promise.reject(new Error("boom")),
      },
    );

    ctl.setTarget({ symbol: "005930", period: "1m" });
    await Promise.resolve();
    await Promise.resolve();
    cvdChangedCalls = 0;

    const ok = ctl.applyLiveTrades("005930", [
      { t: t0 + 1, price: 100_000, qty: 1_200, venue: "krx", strength: null },
      { t: t0 + 2, price: 100_000, qty: 1_500, venue: "krx", strength: null },
      { t: t0 + 61, price: 100_000, qty: 1_000, venue: "krx", strength: null },
    ]);
    expect(ok).toBe(true);
    expect(cvdChangedCalls).toBe(1);
    expect(ctl.cvdPointAt(t0)?.whaleNetMillionWon).toBeCloseTo(270, 5);
    expect(ctl.cvdPointAt(t0 + 60)?.whaleNetMillionWon).toBeCloseTo(370, 5);
    ctl.dispose();
  });
});
