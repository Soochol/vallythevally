// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { ScreenerStatus } from "../../api/generated/ScreenerStatus";
import type { Screens } from "../../api/generated/Screens";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { installDomShims, resetDomAfterEach } from "../../test/domSetup";
import { Toast } from "../toast/Toast";
import { ScreenerPanel } from "./ScreenerPanel";

const NO_CONDITIONS = "조건 없음 · 대상 종목 전체";
const SCREEN_NAME = "조건 없는 대상 종목";

const EVERY_STOCK = [
  ["110010", "가상전자"],
  ["110020", "가상화학"],
  ["110030", "가상분할"],
  ["110035", "가상전자우"],
  ["110040", "가상정지"],
  ["110050", "가상관리"],
  ["110060", "가상200"],
  ["110070", "가상리츠"],
  ["110080", "가상기업인수목적1호"],
  ["110090", "가상신규"],
] as const;

const STATUS: ScreenerStatus = {
  lastDay: "2026-11-06",
  needDay: "2026-11-06",
  todayAvailable: false,
  fullHistory: { done: 10, total: 10 },
  unconfirmed: 0,
  update: null,
};

function makeRows(): ScreenerRow[] {
  return EVERY_STOCK.map(([symbol, name]) => ({
    symbol,
    name,
    close: 50_000,
    changeRate: 1.5,
    matchedDate: "2026-11-06",
    latestBarDate: "2026-11-06",
    provisional: false,
  }));
}

let storedScreens: Screens = { revision: 1, screens: [] };

function mountScreener() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScreenerPanel id={null} />
      <Toast />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installDomShims();
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
  storedScreens = { revision: 1, screens: [] };
  useScreenerStore.setState({ runs: {}, storeVersion: 0, seen: null });
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      if (url.pathname === "/api/screener/status") {
        return new Response(JSON.stringify(STATUS), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/screens") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body ?? "{}")) as { screens?: Screen[] };
          storedScreens = { revision: storedScreens.revision + 1, screens: body.screens ?? [] };
        }
        return new Response(JSON.stringify(storedScreens), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/screener/run") {
        const result: ScreenerResult = {
          asOf: "2026-11-06",
          collectionStartedAt: 1_762_420_000,
          collectionCompletedAt: 1_762_420_010,
          missingSummary: 0,
          universe: EVERY_STOCK.length,
          excluded: { listedTooShort: 0, historyShort: 0, unconfirmed: 0 },
          rows: makeRows(),
        };
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  resetDomAfterEach();
});

test("새 조건식은 조건 없이 열리고 마지막 줄을 빼며, 빈 조건과 시장·제외 설정을 저장하고 반환된 대상 종목을 표시한다", async () => {
  const firstMount = mountScreener();

  fireEvent.click(await screen.findByRole("button", { name: "새 조건식" }));
  const dialog = await screen.findByRole("dialog", { name: "조건 편집 창" });
  expect(within(dialog).getByText(NO_CONDITIONS)).toBeTruthy();
  expect(dialog.textContent).toContain("모든 조건 충족 · 0/10줄");

  fireEvent.click(within(dialog).getByRole("button", { name: "조건 추가" }));
  const picker = await screen.findByRole("dialog", { name: "조건 추가" });
  fireEvent.change(within(picker).getByRole("textbox", { name: "조건 종류 검색" }), { target: { value: "신고가" } });
  fireEvent.click(within(picker).getByText("신고가").closest("button")!);

  const list = within(dialog).getByRole("list", { name: "조건" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);

  fireEvent.click(within(dialog).getByRole("button", { name: "조건 1 메뉴" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "조건 지우기" }));
  expect(within(dialog).getByText(NO_CONDITIONS)).toBeTruthy();
  expect(dialog.textContent).toContain("0/10줄");

  fireEvent.change(within(dialog).getByRole("textbox", { name: "조건식 이름" }), { target: { value: SCREEN_NAME } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
  });
  await waitFor(() => {
    expect(storedScreens.screens).toEqual([
      { id: expect.any(String), name: SCREEN_NAME, markets: [], exclude: [], conditions: [] },
    ]);
  });

  fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
  const panel = screen.getByRole("complementary", { name: "스크리너" });
  expect(within(panel).getByRole("button", { name: "조건식 고르기" }).textContent).toContain(SCREEN_NAME);

  await act(async () => {
    fireEvent.click(within(panel).getByRole("button", { name: "실행" }));
  });
  await waitFor(() => {
    expect(panel.textContent).toContain("대상 10종목 · 빠짐: 상장 기간 부족 0 · 이력 덜 참 0");
  });
  for (const [, name] of EVERY_STOCK) {
    expect(within(panel).getByText(name)).toBeTruthy();
  }

  fireEvent.click(within(panel).getByRole("button", { name: "편집" }));
  const editDialog = await screen.findByRole("dialog", { name: "조건 편집 창" });
  expect(within(editDialog).getByText(NO_CONDITIONS)).toBeTruthy();

  fireEvent.click(within(within(editDialog).getByRole("group", { name: "대상 시장" })).getByRole("button", { name: "코스닥" }));
  fireEvent.click(within(editDialog).getByRole("button", { name: "상태 제외 추가" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "관리종목" }));
  await act(async () => {
    fireEvent.click(within(editDialog).getByRole("button", { name: "저장" }));
  });
  await waitFor(() => {
    expect(storedScreens.screens[0]).toMatchObject({ markets: ["kosdaq"], exclude: ["managed"], conditions: [] });
  });

  firstMount.unmount();
  mountScreener();
  const reloadedPanel = screen.getByRole("complementary", { name: "스크리너" });
  await waitFor(() => {
    expect(within(reloadedPanel).getByRole("button", { name: "조건식 고르기" }).textContent).toContain(SCREEN_NAME);
  });
  fireEvent.click(within(reloadedPanel).getByRole("button", { name: "편집" }));
  const reopenedDialog = await screen.findByRole("dialog", { name: "조건 편집 창" });
  expect(within(reopenedDialog).getByText(NO_CONDITIONS)).toBeTruthy();
  expect(within(within(reopenedDialog).getByRole("group", { name: "대상 시장" })).getByRole("button", { name: "코스닥" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(within(reopenedDialog).getByRole("group", { name: "상태 제외" })).getByRole("button", { name: "관리종목 제외 해제" })).toBeTruthy();
});
