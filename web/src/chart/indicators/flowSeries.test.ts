import { describe, expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { InvestorNetSharesDay } from "../../api/generated/InvestorNetSharesDay";
import type { KstDate } from "../../api/generated/KstDate";
import type { ProgramSeriesPoint } from "../../api/generated/ProgramSeriesPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import {
  bucketInclusiveEndDate,
  buildInvestorSeries,
  buildProgramFlowSeries,
  formatFlowValue,
} from "./flowSeries";
import type { ForeignFlowSpec, ProgramFlowSpec } from "./kinds";

const kstSec = (iso: string): UnixSeconds => Math.floor(Date.parse(`${iso}+09:00`) / 1000);

function investorDay(day: KstDate, foreign: number, institution: number): InvestorNetSharesDay {
  return {
    day,
    individual: -(foreign + institution),
    foreign,
    institution,
    financialInvestment: 0,
    insurance: 0,
    investmentTrust: 0,
    otherFinancial: 0,
    bank: 0,
    pensionFund: 0,
    privateFund: 0,
    government: 0,
    otherCorporation: 0,
  };
}

describe("formatFlowValue", () => {
  test("formats eok values with Korean won units and preserves million-won parity", () => {
    expect(formatFlowValue(2.4, "eok")).toBe("+2.40억");
    expect(formatFlowValue(0.45, "eok")).toBe("+45백만");
    expect(formatFlowValue(-0.3, "eok")).toBe("−30백만");
    expect(formatFlowValue(0, "eok")).toBe("0백만");
    expect(formatFlowValue(12_500, "eok")).toBe("+1.25조");
  });

  test("formats share counts in Korean units", () => {
    expect(formatFlowValue(125_000, "shares")).toBe("+12.5만주");
    expect(formatFlowValue(-45_000, "shares")).toBe("−4.5만주");
    expect(formatFlowValue(3_500, "shares")).toBe("+3,500주");
    expect(formatFlowValue(0, "shares")).toBe("0주");
    expect(formatFlowValue(120_000_000, "shares")).toBe("+1.20억주");
  });
});

describe("buildInvestorSeries", () => {
  const baseSpec: ForeignFlowSpec = {
    kind: "foreignFlow",
    displayMode: "histogram",
    aggregation: "bar",
    unit: "eok",
  };

  test("maps daily bars to eok and shares with bar, cumulative, and both modes", () => {
    const bars: Bar[] = [
      { t: kstSec("2026-11-16T00:00:00"), o: 50_000, h: 51_000, l: 49_500, c: 50_000, v: 100_000 },
      { t: kstSec("2026-11-17T00:00:00"), o: 50_000, h: 52_000, l: 49_800, c: 50_000, v: 120_000 },
      { t: kstSec("2026-11-18T00:00:00"), o: 50_000, h: 50_500, l: 49_000, c: 50_000, v: 90_000 },
    ];
    const days = new Map<KstDate, InvestorNetSharesDay>([
      ["2026-11-16", investorDay("2026-11-16", 200_000, -100_000)],
      ["2026-11-17", investorDay("2026-11-17", -100_000, 300_000)],
      ["2026-11-18", investorDay("2026-11-18", 400_000, 50_000)],
    ]);
    const estimated = new Set<KstDate>(["2026-11-18"]);

    const barEok = buildInvestorSeries(bars, "D", days, estimated, "foreign", baseSpec);
    expect(barEok.bar.map((p) => p.v)).toEqual([100, -50, 200]);
    expect(barEok.cum.map((p) => p.v)).toEqual([100, 50, 250]);
    expect(barEok.byTime.get(bars[2]!.t)).toEqual({ bar: 200, cum: 250, estimated: true });
    expect(barEok.byTime.get(bars[0]!.t)?.estimated).toBe(false);

    const cumEok = buildInvestorSeries(bars, "D", days, estimated, "foreign", {
      ...baseSpec,
      aggregation: "cumulative",
    });
    expect(cumEok.bar.map((p) => p.v)).toEqual([100, 50, 250]);
    expect(cumEok.line.map((p) => p.v)).toEqual([100, 50, 250]);

    const bothShares = buildInvestorSeries(bars, "D", days, estimated, "institution", {
      kind: "institutionFlow",
      displayMode: "both",
      aggregation: "cumulative",
      unit: "shares",
    });
    expect(bothShares.bar.map((p) => p.v)).toEqual([-100_000, 300_000, 50_000]);
    expect(bothShares.cum.map((p) => p.v)).toEqual([-100_000, 200_000, 250_000]);
  });

  test("rolls up daily investor rows into weekly and monthly buckets without dropping days", () => {
    const weeklyBars: Bar[] = [
      { t: kstSec("2026-11-09T00:00:00"), o: 50_000, h: 52_000, l: 49_000, c: 50_000, v: 500_000 },
      { t: kstSec("2026-11-16T00:00:00"), o: 50_000, h: 53_000, l: 50_000, c: 50_000, v: 600_000 },
    ];
    const days = new Map<KstDate, InvestorNetSharesDay>([
      ["2026-11-09", investorDay("2026-11-09", 10_000, 0)],
      ["2026-11-11", investorDay("2026-11-11", 30_000, 0)],
      ["2026-11-13", investorDay("2026-11-13", -5_000, 0)],
      ["2026-11-16", investorDay("2026-11-16", 20_000, 0)],
      ["2026-11-19", investorDay("2026-11-19", 40_000, 0)],
    ]);
    const estimated = new Set<KstDate>(["2026-11-19"]);

    const weekly = buildInvestorSeries(weeklyBars, "W", days, estimated, "foreign", {
      ...baseSpec,
      unit: "shares",
    });
    expect(weekly.bar.map((p) => p.v)).toEqual([35_000, 60_000]);
    expect(weekly.cum.map((p) => p.v)).toEqual([35_000, 95_000]);
    expect(weekly.byTime.get(weeklyBars[0]!.t)?.estimated).toBe(false);
    expect(weekly.byTime.get(weeklyBars[1]!.t)?.estimated).toBe(true);
    expect(bucketInclusiveEndDate(weeklyBars[1]!.t, "W")).toBe("2026-11-22");
    expect(bucketInclusiveEndDate(kstSec("2026-11-01T00:00:00"), "M")).toBe("2026-11-30");
  });
});

describe("buildProgramFlowSeries", () => {
  const progSpec: ProgramFlowSpec = {
    kind: "programFlow",
    displayMode: "histogram",
    aggregation: "cumulative",
    unit: "eok",
    showShare: true,
  };

  test("computes intraday same-day bar delta and resets across days", () => {
    const t1 = kstSec("2026-11-23T09:00:00");
    const t2 = kstSec("2026-11-23T09:05:00");
    const t3 = kstSec("2026-11-24T09:00:00");
    const bars: Bar[] = [
      { t: t1, o: 70_000, h: 70_100, l: 69_900, c: 70_000, v: 100 },
      { t: t2, o: 70_000, h: 70_200, l: 70_000, c: 70_100, v: 120 },
      { t: t3, o: 70_200, h: 70_300, l: 70_100, c: 70_200, v: 110 },
    ];
    const points = new Map<UnixSeconds, ProgramSeriesPoint>([
      [t1, { t: t1, netBuyAmountMillionWon: 120, netBuyQty: 1_500, buyAmountMillionWon: 200, sellAmountMillionWon: 80, programSharePct: 15 }],
      [t2, { t: t2, netBuyAmountMillionWon: 300, netBuyQty: 4_000, buyAmountMillionWon: 420, sellAmountMillionWon: 120, programSharePct: 22 }],
      [t3, { t: t3, netBuyAmountMillionWon: -50, netBuyQty: -700, buyAmountMillionWon: 100, sellAmountMillionWon: 150, programSharePct: 10 }],
    ]);

    const cumRes = buildProgramFlowSeries(bars, "5m", points, null, progSpec);
    expect(cumRes.bar.map((p) => p.v)).toEqual([1.2, 3, -0.5]);
    expect(cumRes.share.map((p) => p.v)).toEqual([15, 22, 10]);

    const barRes = buildProgramFlowSeries(bars, "5m", points, null, { ...progSpec, aggregation: "bar" });
    expect(barRes.bar.map((p) => Number(p.v.toFixed(4)))).toEqual([1.2, 1.8, -0.5]);

    const bothShares = buildProgramFlowSeries(bars, "5m", points, null, { ...progSpec, displayMode: "both", unit: "shares" });
    expect(bothShares.bar.map((p) => p.v)).toEqual([1_500, 2_500, -700]);
    expect(bothShares.cum.map((p) => p.v)).toEqual([1_500, 4_000, -700]);
  });

  test("treats daily points as per-bar and accumulates for cumulative mode with shares fallback", () => {
    const d1 = kstSec("2026-11-23T00:00:00");
    const d2 = kstSec("2026-11-24T00:00:00");
    const bars: Bar[] = [
      { t: d1, o: 50_000, h: 51_000, l: 49_500, c: 50_000, v: 500_000 },
      { t: d2, o: 50_000, h: 52_000, l: 49_800, c: 50_000, v: 600_000 },
    ];
    const points = new Map<UnixSeconds, ProgramSeriesPoint>([
      [d1, { t: d1, netBuyAmountMillionWon: 500, netBuyQty: 0, buyAmountMillionWon: 800, sellAmountMillionWon: 300, programSharePct: 18 }],
      [d2, { t: d2, netBuyAmountMillionWon: -200, netBuyQty: -4_200, buyAmountMillionWon: 400, sellAmountMillionWon: 600, programSharePct: 14 }],
    ]);

    const dailyBar = buildProgramFlowSeries(bars, "D", points, null, { ...progSpec, aggregation: "bar" });
    expect(dailyBar.bar.map((p) => p.v)).toEqual([5, -2]);
    expect(dailyBar.cum.map((p) => p.v)).toEqual([5, 3]);

    const dailyCum = buildProgramFlowSeries(bars, "D", points, null, { ...progSpec, aggregation: "cumulative" });
    expect(dailyCum.bar.map((p) => p.v)).toEqual([5, 3]);

    const dailyShares = buildProgramFlowSeries(bars, "D", points, null, { ...progSpec, aggregation: "bar", unit: "shares" });
    expect(dailyShares.bar.map((p) => p.v)).toEqual([10_000, -4_200]);
  });
});
