// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { FeedBrokerStatus } from "../../api/generated/FeedBrokerStatus";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerStatus } from "../../api/generated/ScreenerStatus";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { installDomShims, resetDomAfterEach } from "../../test/domSetup";
import { Toast } from "../toast/Toast";
import { ScreenerPanel } from "./ScreenerPanel";

const REFUSAL = "스크리너 갱신은 연결된 키움 키가 있어야 합니다. 지금은 연결된 키움 키가 없습니다";
const NEW_HIGH = { kind: "new_high", period: "D", field: "close", n: 60, recentBars: 1 } as const;

const FEED_KIWOOM: FeedBrokerStatus = { broker: "kiwoom", rankingKinds: [], rankingChoices: [], overviewFeatures: [] };
const FEED_KIS: FeedBrokerStatus = { broker: "kis", rankingKinds: [], rankingChoices: [], overviewFeatures: [] };
const KIS_SOURCE: MarketSourceStatus = { broker: "kis", keyId: "kis1", alias: "한투 1", state: "connected", problem: null, step: null, retryAt: null, features: [], feedBroker: FEED_KIS };
const KIS_SOURCE_WITH_KIWOOM_FEED: MarketSourceStatus = { ...KIS_SOURCE, feedBroker: FEED_KIWOOM };

const STATUS: ScreenerStatus = {
  lastDay: "2026-11-06",
  needDay: "2026-11-06",
  todayAvailable: false,
  fullHistory: { done: 10, total: 10 },
  unconfirmed: 0,
  update: null,
};

const RESULT: ScreenerResult = {
  asOf: "2026-11-06",
  collectionStartedAt: 1_762_420_000,
  collectionCompletedAt: 1_762_420_010,
  missingSummary: 0,
  universe: 10,
  excluded: { listedTooShort: 0, historyShort: 0, unconfirmed: 0 },
  rows: [{ symbol: "110010", name: "가상전자", close: 50_000, changeRate: 1.5, matchedDate: "2026-11-06", latestBarDate: "2026-11-06", provisional: false }],
};

let activeClient: QueryClient | null = null;
let updateFail = false;

function mountScreener() {
  activeClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={activeClient}>
      <ScreenerPanel id={null} />
      <Toast />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installDomShims();
  updateFail = false;
  useScreenerStore.setState({ runs: {}, storeVersion: 0, seen: null });
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
  useKiwoomLinkStore.getState().receiveSourcePush(KIS_SOURCE);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      if (url.pathname === "/api/screener/status") {
        return new Response(JSON.stringify(STATUS), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/screens") {
        return new Response(
          JSON.stringify({ revision: 1, screens: [{ id: "high", name: "고점", markets: [], exclude: [], conditions: [NEW_HIGH] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/api/screener/run") {
        return new Response(JSON.stringify(RESULT), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/screener/update") {
        if (updateFail) {
          return new Response(
            JSON.stringify({ error: { code: "bad_request", message: REFUSAL, reason: "unsupported_by_source", retryAt: null, manualActionRequired: false } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(STATUS), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});

resetDomAfterEach();

test("실행 단추가 눌리고 결과가 보인다", async () => {
  mountScreener();
  const runBtn = await screen.findByRole("button", { name: "실행" });
  await waitFor(() => expect(runBtn.hasAttribute("disabled")).toBe(false));
  fireEvent.click(runBtn);
  await waitFor(() => expect(screen.getByRole("region", { name: "결과" }).getAttribute("aria-busy")).toBe("false"));
  expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  activeClient?.clear();
});

test("업데이트 단추는 꺼져 있고 키움 키가 필요하다고 알려 준다", async () => {
  mountScreener();
  const update = await screen.findByRole("button", { name: /^업데이트/ });
  expect(update.hasAttribute("disabled")).toBe(true);
  expect(update.getAttribute("title")).toBe("키움 키가 있어야 갱신합니다");
  activeClient?.clear();
});

test("업데이트 단추가 눌린 사이 서버가 거절하면 서버의 거절 문구가 보인다", async () => {
  updateFail = true;
  mountScreener();
  const update = await screen.findByRole("button", { name: /^업데이트/ });
  act(() => {
    useKiwoomLinkStore.getState().receiveSourcePush(KIS_SOURCE_WITH_KIWOOM_FEED);
  });
  await waitFor(() => expect(update.hasAttribute("disabled")).toBe(false));
  fireEvent.click(update);
  await waitFor(() => {
    const toast = document.querySelector(".ui-toast");
    expect(toast?.textContent).toContain(REFUSAL);
  });
  activeClient?.clear();
});
