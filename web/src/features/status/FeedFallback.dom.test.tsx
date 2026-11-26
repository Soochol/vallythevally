// @vitest-environment happy-dom
import { fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { Ranking } from "../../api/generated/Ranking";
import type { ScreenerStatus } from "../../api/generated/ScreenerStatus";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { windowId } from "../../layout/kinds";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useLayoutStore } from "../../stores/layout";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { MarketPage } from "../market-page/MarketPage";
import { RankingWindow } from "../ranking/RankingWindow";
import { ScreenerPanel } from "../screener/ScreenerPanel";

const CONNECTED_KIWOOM: KiwoomLinkStatus = {
  environment: "real",
  keySource: "file",
  appKeyTail: "7Z2D",
  credentialId: "k1",
  state: "connected",
  problem: null,
  message: "연결됨",
  retryAt: null,
  needsAcknowledgement: false,
  step: "realtime",
  tokenExpiresAt: 1_800_000_000,
  realtimeRegistered: 1,
  symbolCount: 2500,
  registeredIp: null,
  atStart: null,
};

const KIS_FAILED_KIWOOM_RECEIVES: MarketSourceStatus = {
  broker: "kis",
  keyId: "kis1",
  alias: "한투 1",
  state: "failed",
  problem: "network",
  step: null,
  retryAt: null,
  features: ["quotes", "orderBook"],
  feedBroker: { broker: "kiwoom", rankingKinds: ["tradeAmount", "expected"], rankingChoices: [], overviewFeatures: ["index", "flow", "sectors", "intradayFlow", "turnover"] },
};

const KIS_FAILED_NOBODY_RECEIVES: MarketSourceStatus = {
  ...KIS_FAILED_KIWOOM_RECEIVES,
  feedBroker: null,
};

const KIS_MARKET_SOURCE: MarketSourceStatus = {
  broker: "kis",
  keyId: "kis1",
  alias: "한투 1",
  state: "connected",
  problem: null,
  step: "realtime",
  retryAt: null,
  features: ["quotes", "orderBook", "minuteBars"],
  feedBroker: {
    broker: "kis",
    rankingKinds: ["tradeAmount", "expected"],
    rankingChoices: [{ kind: "expected", choices: { venues: ["combined"], sessions: ["regular"], baselines: ["previousDay"], minTradeAmounts: ["any"], investors: [], spans: [], surgeSorts: [], excludesManaged: false } }],
    overviewFeatures: [],
  },
};

const EXPECTED_RANKING: Ranking = {
  kind: "expected",
  market: "all",
  venue: "combined",
  sort: "gainers",
  excludes: { etfEtn: true, preferred: false },
  excludeManaged: true,
};

const READY_STATUS: ScreenerStatus = {
  lastDay: "2026-11-06",
  needDay: "2026-11-06",
  todayAvailable: false,
  fullHistory: { done: 10, total: 10 },
  unconfirmed: 0,
  update: null,
};

beforeEach(() => {
  useSelectionStore.setState({ dialog: null, activeCell: windowId("cell-0"), toasts: [], toast: null });
  useScreenerStore.setState({ runs: {}, storeVersion: 0, seen: null });
  useKiwoomLinkStore.getState().receiveSnapshot(CONNECTED_KIWOOM, 0);
});

resetDomAfterEach();

test("한투 연결이 실패해도 키움이 feedBroker이면 시장 종합·순위 창·스크리너 갱신이 막히지 않는다", async () => {
  useKiwoomLinkStore.getState().receiveSourceSnapshot(KIS_FAILED_KIWOOM_RECEIVES, 0);
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("rk-1"), link: null, kind: "ranking", ranking: { kind: "tradeAmount", market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } },
      ],
    },
  }));

  stubFetch(({ pathname }) => {
    if (pathname === "/api/market/index") {
      return { body: { market: "kospi", name: "코스피", value: 2500, change: 10, changeRate: 0.4, breadth: { adv: 500, dec: 300, flat: 50, upperLimit: 0, lowerLimit: 0 }, context: { phase: "regular", receivedAt: 1700000000 } } };
    }
    if (pathname === "/api/market/flows") return { body: { market: "kospi", items: [{ name: "외국인", subject: "foreign", netAmountMillionWon: 100, buyAmountMillionWon: 300, sellAmountMillionWon: 200 }], context: { phase: "regular", receivedAt: 1700000000 } } };
    if (pathname === "/api/rankings") return { body: { kind: "tradeAmount", market: "all", venue: "combined", source: "kiwoom", asOf: 1700000000, rows: [{ rank: 1, code: "005930", name: "삼성전자", listed: true, price: 70000, changeRate: 1.5, figures: { kind: "tradeAmount", tradedAmountMillionWon: 50000, tradedVolume: 1000, turnoverPct: null } }] } };
    if (pathname === "/api/screener/status") return { body: READY_STATUS };
    if (pathname === "/api/screens") return { body: { revision: 1, screens: [] } };
    return { body: {} };
  });

  const { client } = renderWithProviders(
    <Routes>
      <Route path="/" element={<><RankingWindow id={windowId("rk-1")} /><ScreenerPanel id={null} /></>} />
    </Routes>,
  );

  expect(await screen.findByTestId("ranking-row")).toBeTruthy();
  expect(screen.queryByText("키움 연결 전입니다")).toBeNull();
  const updateBtn = await screen.findByRole("button", { name: /^업데이트/ });
  expect((updateBtn as HTMLButtonElement).disabled).toBe(false);
  client.clear();

  useKiwoomLinkStore.getState().receiveSourceSnapshot(KIS_FAILED_KIWOOM_RECEIVES, 0);
  const marketView = renderWithProviders(<MarketPage />);
  expect(await screen.findByText("코스피")).toBeTruthy();
  expect(screen.queryByText("키움 연결 전입니다")).toBeNull();
  marketView.client.clear();
});

test("한투 연결이 실패했고 feedBroker도 없으면 시장 종합·순위 창·스크리너가 연결 전 안내로 막힌다", async () => {
  useKiwoomLinkStore.getState().receiveSourceSnapshot(KIS_FAILED_NOBODY_RECEIVES, 0);
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("rk-1"), link: null, kind: "ranking", ranking: { kind: "tradeAmount", market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } },
      ],
    },
  }));

  stubFetch(({ pathname }) => {
    if (pathname === "/api/screener/status") return { body: READY_STATUS };
    if (pathname === "/api/screens") return { body: { revision: 1, screens: [] } };
    return { body: {} };
  });

  const { client } = renderWithProviders(
    <>
      <MarketPage />
      <RankingWindow id={windowId("rk-1")} />
      <ScreenerPanel id={null} />
    </>,
  );

  expect((await screen.findAllByText("키움 연결 전입니다")).length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByTestId("ranking-row")).toBeNull();
  const blockedBtn = await screen.findByRole("button", { name: /^업데이트/ });
  expect((blockedBtn as HTMLButtonElement).disabled).toBe(true);
  expect(blockedBtn.textContent).toContain("연결 뒤");
  client.clear();
});

test("한투가 받는 예상체결 순위는 관리종목 빼기가 꺼지고 비활성화된다", async () => {
  useKiwoomLinkStore.getState().receiveSourceSnapshot(KIS_MARKET_SOURCE, 0);
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("rk-exp"), link: null, kind: "ranking", ranking: EXPECTED_RANKING },
      ],
    },
  }));
  stubFetch(({ pathname }) => {
    if (pathname === "/api/rankings") return { body: { kind: "expected", market: "all", venue: "combined", source: "kis", asOf: 1700000000, rows: [] } };
    return { body: {} };
  });

  const { client } = renderWithProviders(<RankingWindow id={windowId("rk-exp")} />);
  fireEvent.click(await screen.findByRole("button", { name: "조건" }));
  const managed = within(screen.getByRole("dialog", { name: "순위 조건" })).getByRole("button", { name: "관리종목 빼기" }) as HTMLButtonElement;
  expect(managed.disabled).toBe(true);
  expect(managed.getAttribute("aria-pressed")).toBe("false");
  expect(managed.getAttribute("title")).toBe("한투로 받을 때는 고를 수 없습니다");
  client.clear();
});
