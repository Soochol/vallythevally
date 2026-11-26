// @vitest-environment happy-dom
import { fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { EtfAccumulation } from "../../api/generated/EtfAccumulation";
import type { EtfChanges } from "../../api/generated/EtfChanges";
import type { EtfFlowRanking } from "../../api/generated/EtfFlowRanking";
import type { EtfFundDetail } from "../../api/generated/EtfFundDetail";
import type { EtfFundList } from "../../api/generated/EtfFundList";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfHistory } from "../../api/generated/EtfHistory";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { EtfPage } from "./EtfPage";

const FUND_444200: EtfFundSummary = {
  code: "444200",
  name: "KODEX AI반도체",
  issuer: "삼성",
  style: "active",
  benchmark: "AI반도체",
  holdingsCount: 4,
  top5WeightBps: 8500,
  effectiveHoldings: 3.5,
  status: { source: "collected", holdingsAsOf: "2026-11-18", lastAttemptAt: null, refreshFailed: false },
  recentActivity: null,
  latestAumWon: 500_000_000_000,
  netFlow5dWon: 12_000_000_000,
};

const FUND_091160: EtfFundSummary = {
  ...FUND_444200,
  code: "091160",
  name: "KODEX 반도체",
  style: "passive",
  status: { source: "collected", holdingsAsOf: "2026-11-18", lastAttemptAt: null, refreshFailed: false },
  latestAumWon: 200_000_000_000,
};

const FUND_LIST: EtfFundList = { funds: [FUND_444200, FUND_091160] };

const DETAIL: EtfFundDetail = {
  fund: FUND_444200,
  holdings: [{ code: "000660", name: "SK하이닉스", weightBps: 2500, ma: { ma20: null, ma60: null, ma120: null } }],
  maAsOf: "2026-11-18",
};

const HISTORY: EtfHistory = {
  code: "444200",
  firstCollectedOn: "2026-11-12",
  pairs: [
    { before: "2026-11-14", after: "2026-11-18", commonScale: 0.94, added: 1, removed: 1, increased: 1, decreased: 1 },
    { before: "2026-11-12", after: "2026-11-14", commonScale: 1, added: 0, removed: 0, increased: 1, decreased: 0 },
  ],
};

const SINGLE_HISTORY: EtfHistory = {
  code: "091160",
  firstCollectedOn: "2026-11-18",
  pairs: [],
};

const LATEST_CHANGES: EtfChanges = {
  code: "444200",
  before: "2026-11-14",
  after: "2026-11-18",
  commonScale: 0.94,
  rows: [
    { code: "000660", name: "SK하이닉스", beforeQuantity: 1000, afterQuantity: 1200, realChange: 0.277, kind: "increased" },
    { code: "035420", name: "NAVER", beforeQuantity: 1000, afterQuantity: 940, realChange: 0, kind: "unchanged" },
    { code: "402340", name: "SK스퀘어", beforeQuantity: null, afterQuantity: 300, realChange: null, kind: "added" },
    { code: "086520", name: "에코프로", beforeQuantity: 100, afterQuantity: null, realChange: null, kind: "removed" },
  ],
};

const EARLIER_CHANGES: EtfChanges = {
  code: "444200",
  before: "2026-11-12",
  after: "2026-11-14",
  commonScale: 1,
  rows: [{ code: "051910", name: "LG화학", beforeQuantity: 100, afterQuantity: 110, realChange: 0.1, kind: "increased" }],
};

const FLOWS: EtfFlowRanking = {
  status: { state: "ready", configured: true, latestDate: "2026-11-18", firstDate: "2026-11-01", collectedDays: 20, backfillTargetDays: 20, lastAttemptAt: null, message: null },
  window: 5,
  direction: "inflow",
  scope: "all",
  sort: "amount",
  fromDate: "2026-11-12",
  toDate: "2026-11-18",
  summary: { totalEtfCount: 2, totalAumWon: 700_000_000_000, totalNetFlowWon: 25_000_000_000, inflowEtfCount: 1, outflowEtfCount: 1, inflowTotalWon: 30_000_000_000, outflowTotalWon: 5_000_000_000, topInflowCode: "444200", topInflowName: "KODEX AI반도체", topInflowWon: 12_000_000_000, topOutflowCode: null, topOutflowName: null, topOutflowWon: null },
  rows: [
    {
      code: "444200",
      name: "KODEX AI반도체",
      issuer: "삼성",
      inCatalog: true,
      style: "active",
      listedShares: 1_000_000,
      shareChange: 100_000,
      shareChangePct: 10,
      netFlowWon: 12_000_000_000,
      netFlow1dWon: 3_000_000_000,
      netFlow5dWon: 12_000_000_000,
      netFlow20dWon: 25_000_000_000,
      flowToAumPct: 2.4,
      aumWon: 500_000_000_000,
      marketCapWon: 500_000_000_000,
      nav: 10_000,
      closePrice: 10_050,
      premiumBps: 50,
      streakDays: 3,
      sparklineFlow: [1, 2, 3],
    },
  ],
};

const ACCUMULATION: EtfAccumulation = {
  window: 5,
  style: "active",
  direction: "buy",
  fromDate: "2026-11-14",
  toDate: "2026-11-18",
  collectedDays: 5,
  maAsOf: "2026-11-18",
  rows: [
    {
      code: "000660",
      name: "SK하이닉스",
      buyingEtfCount: 3,
      addedEtfCount: 1,
      increasedEtfCount: 2,
      sellingEtfCount: 0,
      removedEtfCount: 0,
      decreasedEtfCount: 0,
      medianRealChange: 12.5,
      ma: { ma20: null, ma60: null, ma120: null },
      contributors: [{ fundCode: "444200", fundName: "KODEX AI반도체", style: "active", kind: "increased", realChange: 12.5, beforeWeightBps: 2000, afterWeightBps: 2500 }],
    },
  ],
};

beforeEach(() => {
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
});

resetDomAfterEach();

function renderEtf(route = "/etf?code=444200&tab=history", overrides: { changesFailOnce?: boolean } = {}) {
  let failOnce = overrides.changesFailOnce ?? false;
  stubFetch(({ pathname, url }) => {
    if (pathname === "/api/etf/funds") return { body: FUND_LIST };
    if (pathname === "/api/etf/funds/444200") return { body: DETAIL };
    if (pathname === "/api/etf/funds/091160") return { body: { ...DETAIL, fund: FUND_091160 } };
    if (pathname === "/api/etf/funds/444200/history") return { body: HISTORY };
    if (pathname === "/api/etf/funds/091160/history") return { body: SINGLE_HISTORY };
    if (pathname === "/api/etf/funds/444200/changes") {
      if (failOnce) {
        failOnce = false;
        return { status: 503, body: { error: { code: "internal", message: "실패", reason: null, retryAt: null, manualActionRequired: false } } };
      }
      return { body: url.searchParams.get("before") === "2026-11-12" ? EARLIER_CHANGES : LATEST_CHANGES };
    }
    if (pathname === "/api/etf/flows") return { body: FLOWS };
    if (pathname === "/api/etf/accumulation") return { body: ACCUMULATION };
    if (pathname === "/api/etf/stocks/000660") return { body: { code: "000660", name: "SK하이닉스", holders: [] } };
    return { body: {} };
  });

  return renderWithProviders(
    <Routes>
      <Route path="/etf" element={<EtfPage />} />
      <Route path="/" element={<div data-testid="home-chart" />} />
    </Routes>,
    { route },
  );
}

test("ETF 변경 이력 타임라인, 쌍 선택, CU 보정 토글, 단일 수집일 안내 및 오류 재시도", async () => {
  const { client } = renderEtf("/etf?code=444200&tab=history", { changesFailOnce: true });

  expect(await screen.findByText(/증감을 불러오지 못했습니다/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

  const table = await screen.findByRole("table", { name: "종목별 증감 표" });
  expect(within(table).getByText("SK하이닉스")).toBeTruthy();
  expect(table.textContent).toContain("+27.7%");
  expect(table.textContent).toContain("유지");

  fireEvent.click(screen.getByRole("button", { name: /보정 OFF/ }));
  expect(table.textContent).toContain("+20.0%");
  expect(table.textContent).toContain("CU 노이즈");

  const timeline = screen.getByRole("region", { name: "날짜 쌍 타임라인" });
  const earlierBtn = timeline.querySelector('[data-pair="2026-11-14"]')!;
  fireEvent.click(earlierBtn);
  expect(await screen.findByText("LG화학")).toBeTruthy();
  expect(within(screen.getByRole("table", { name: "종목별 증감 표" })).queryByText("SK하이닉스")).toBeNull();

  fireEvent.click(screen.getByRole("list", { name: "ETF" }).querySelector('[data-code="091160"]')!);
  expect(await screen.findByText(/첫 수집일 2026-11-18/)).toBeTruthy();
  client.clear();
});

test("자금 유입(flows) 및 ETF 매수 축적(accumulation) 탭 전환과 상세 펼치기가 동작한다", async () => {
  const { client } = renderEtf("/etf?code=444200&tab=flows");

  expect((await screen.findAllByText("KODEX AI반도체")).length).toBeGreaterThanOrEqual(1);

  fireEvent.click(screen.getByRole("tab", { name: "동시 매집" }));
  const toggleBtn = await screen.findByRole("button", { name: "SK하이닉스 매집 ETF 펼치기" });
  fireEvent.click(toggleBtn);
  expect((await screen.findAllByText("KODEX AI반도체")).length).toBeGreaterThanOrEqual(1);
  client.clear();
});
