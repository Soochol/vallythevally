import { describe, expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { DayHistory } from "../../api/generated/DayHistory";
import type { InvestorNetSharesDay } from "../../api/generated/InvestorNetSharesDay";
import type { KstDate } from "../../api/generated/KstDate";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { IndicatorConfig } from "../settings";
import type { ThemeTokens } from "../theme";
import { InvestorFlowController } from "./investorFamily";

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

const kstSec = (iso: string): UnixSeconds => Math.floor(Date.parse(`${iso}+09:00`) / 1000);

const FOREIGN_CONFIG: IndicatorConfig = {
  id: "foreign",
  spec: { kind: "foreignFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" },
  panel: "p-foreign",
  visible: true,
  style: { colors: ["ind-1"], width: 1 },
};

const INST_CONFIG: IndicatorConfig = {
  id: "inst",
  spec: { kind: "institutionFlow", displayMode: "histogram", aggregation: "bar", unit: "eok" },
  panel: "p-inst",
  visible: true,
  style: { colors: ["ind-2"], width: 1 },
};

function makePage(days: InvestorNetSharesDay[], estimatedDays?: KstDate[]): DayHistory<InvestorNetSharesDay> {
  return {
    symbol: "005930",
    from: "2026-11-16",
    to: "2026-11-18",
    coverage: { kind: "whole_range" },
    days,
    source: "kiwoom",
    skippedDays: [],
    undatedRows: [],
    ...(estimatedDays ? { estimatedDays } : {}),
  };
}

describe("InvestorFlowController", () => {
  test("shares one HTTP request across foreign and institution indicators and surfaces estimated badge", async () => {
    const t1 = kstSec("2026-11-16T00:00:00");
    const t2 = kstSec("2026-11-17T00:00:00");
    const bars: Bar[] = [
      { t: t1, o: 50_000, h: 51_000, l: 49_500, c: 50_000, v: 100_000 },
      { t: t2, o: 50_000, h: 52_000, l: 49_800, c: 50_000, v: 120_000 },
    ];
    let fetchCount = 0;
    let changed = 0;

    const ctl = new InvestorFlowController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [FOREIGN_CONFIG, INST_CONFIG],
        onInvestorChanged: () => { changed++; },
      },
      {
        fetchInvestorNetShares: async () => {
          fetchCount++;
          return makePage(
            [
              { day: "2026-11-16", individual: 0, foreign: 200_000, institution: -100_000, financialInvestment: 0, insurance: 0, investmentTrust: 0, otherFinancial: 0, bank: 0, pensionFund: 0, privateFund: 0, government: 0, otherCorporation: 0 },
              { day: "2026-11-17", individual: 0, foreign: -40_000, institution: 80_000, financialInvestment: 0, insurance: 0, investmentTrust: 0, otherFinancial: 0, bank: 0, pensionFund: 0, privateFund: 0, government: 0, otherCorporation: 0 },
            ],
            ["2026-11-17"],
          );
        },
      },
    );

    ctl.setTarget({ symbol: "005930", period: "D" });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchCount).toBe(1);
    expect(changed).toBeGreaterThan(0);

    const foreignRow1 = ctl.row(FOREIGN_CONFIG, t1, TOKENS, null);
    expect(foreignRow1.values).toEqual([{ text: "순매수 +100.00억", color: TOKENS.up }]);

    const instRow1 = ctl.row(INST_CONFIG, t1, TOKENS, null);
    expect(instRow1.values).toEqual([{ text: "순매수 −50.00억", color: TOKENS.down }]);

    const foreignRow2 = ctl.row(FOREIGN_CONFIG, t2, TOKENS, null);
    expect(foreignRow2.values).toEqual([
      { text: "순매수 −20.00억", color: TOKENS.down },
      { text: "추정", color: TOKENS.text3 },
    ]);

    ctl.setTarget({ symbol: "005930", period: "5m" });
    expect(ctl.row(FOREIGN_CONFIG, t2, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 일봉 이상 전용"]);
    expect(ctl.row(INST_CONFIG, t2, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 일봉 이상 전용"]);

    ctl.setTarget({ symbol: "IDX:001", period: "D" });
    expect(ctl.row(FOREIGN_CONFIG, t2, TOKENS, null).values.map((v) => v.text)).toEqual(["주식·ETF 일봉 이상 전용"]);
    expect(fetchCount).toBe(1);
    ctl.dispose();
  });

  test("shows failure notice when fetch rejects with no cached data", async () => {
    const t1 = kstSec("2026-11-16T00:00:00");
    const bars: Bar[] = [{ t: t1, o: 50_000, h: 51_000, l: 49_500, c: 50_000, v: 100_000 }];

    const ctl = new InvestorFlowController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [FOREIGN_CONFIG],
        onInvestorChanged: () => {},
      },
      {
        fetchInvestorNetShares: async () => {
          throw new Error("network");
        },
      },
    );

    ctl.setTarget({ symbol: "005930", period: "D" });
    await Promise.resolve();
    await Promise.resolve();

    expect(ctl.feedState()).toBe("failed");
    expect(ctl.row(FOREIGN_CONFIG, t1, TOKENS, null).values.map((v) => v.text)).toEqual(["투자자 수급 조회 실패"]);
    ctl.dispose();
  });
});
