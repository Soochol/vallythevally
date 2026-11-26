// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { Condition } from "../../api/generated/Condition";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerStatus } from "../../api/generated/ScreenerStatus";
import type { Screens } from "../../api/generated/Screens";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { windowId } from "../../layout/kinds";
import { ScreenerPanel } from "./ScreenerPanel";

const STATUS: ScreenerStatus = {
  lastDay: "2026-11-06",
  needDay: "2026-11-06",
  todayAvailable: false,
  fullHistory: { done: 16, total: 16 },
  unconfirmed: 0,
  update: null,
};

const WEEKLY_HIGH: Screen = {
  id: "plain",
  name: "주봉 신고가",
  markets: [],
  exclude: [],
  conditions: [{ kind: "new_high", period: "W", recentBars: 4, field: "high", n: 52 } satisfies Condition],
};

beforeEach(() => {
  useScreenerStore.setState({ runs: {}, storeVersion: 0, seen: null });
  useSelectionStore.setState({ dialog: null, activeCell: windowId("cell-0"), toasts: [], toast: null });
});

resetDomAfterEach();

function setupScreener(initial: Screen[] = [WEEKLY_HIGH]) {
  let doc: Screens = { revision: 1, screens: initial };
  const runBodies: Screen[] = [];
  const api = stubFetch(({ method, pathname, json }) => {
    if (pathname === "/api/screener/status") return { body: STATUS };
    if (pathname === "/api/screens") {
      if (method === "PUT") {
        const body = json() as Screens;
        doc = { revision: doc.revision + 1, screens: body.screens };
      }
      return { body: doc };
    }
    if (pathname === "/api/screener/run") {
      const screenBody = json() as Screen;
      runBodies.push(screenBody);
      return {
        body: {
          asOf: "2026-11-06",
          collectionStartedAt: 1_700_000_000,
          collectionCompletedAt: 1_700_000_005,
          missingSummary: 0,
          universe: 16,
          excluded: { listedTooShort: 2, historyShort: 0, unconfirmed: 0 },
          rows: [
            {
              symbol: "120010",
              name: "가상교차급증",
              close: 50_000,
              changeRate: 4.2,
              matchedDate: "2026-11-06",
              latestBarDate: "2026-11-06",
              provisional: false,
              programNetMillionWon: 1700,
              tradedMillionWon: 95_000,
            },
          ],
        } satisfies ScreenerResult,
      };
    }
    return { body: {} };
  });

  return { api, getDoc: () => doc, runBodies };
}

test("신고거래량·신고거래대금 조건 전환, 최근 기간 유지, 0 입력 저장 검증 및 저장", async () => {
  const env = setupScreener([WEEKLY_HIGH]);
  const { client } = renderWithProviders(<ScreenerPanel id={null} />);

  await screen.findByText("주봉 신고가");
  fireEvent.click(screen.getByRole("button", { name: "편집" }));
  const editor = await screen.findByRole("region", { name: "조건식 편집" });

  fireEvent.click(within(editor).getByRole("button", { name: "조건 1 종류" }));
  const picker = await screen.findByRole("dialog", { name: "조건 1 종류 바꾸기" });
  fireEvent.change(within(picker).getByRole("textbox", { name: "조건 종류 검색" }), { target: { value: "신고거래대금" } });
  fireEvent.click(within(picker).getByRole("button", { name: "신고거래대금" }));
  expect(within(editor).getByRole("button", { name: "조건 1 최근 기간" }).textContent).toBe("4");

  fireEvent.click(within(editor).getByRole("button", { name: "조건 1 최근 기간" }));
  const input1 = within(editor).getByRole("textbox", { name: "조건 1 최근 기간" });
  fireEvent.change(input1, { target: { value: "0" } });
  fireEvent.keyDown(input1, { key: "Enter" });
  expect(within(editor).getByRole("alert").textContent).toContain("1 이상");

  fireEvent.click(within(editor).getByRole("button", { name: "조건 1 최근 기간" }));
  const input2 = within(editor).getByRole("textbox", { name: "조건 1 최근 기간" });
  fireEvent.change(input2, { target: { value: "100" } });
  fireEvent.keyDown(input2, { key: "Enter" });
  fireEvent.click(within(editor).getByRole("button", { name: "저장" }));

  await waitFor(() => expect(env.getDoc().screens[0]!.conditions[0]).toMatchObject({ kind: "new_high", field: "traded_value", recentBars: 100 }));
  client.clear();
});

test("프로그램 순매수와 신고가 조건식을 만들고 실행해 프로그램 열·열 설정·결과 내 검색을 검증한다", async () => {
  const env = setupScreener([]);
  const { client } = renderWithProviders(<ScreenerPanel id={null} />);

  await screen.findByText(/조건식/);
  fireEvent.click(screen.getByRole("button", { name: "새 조건식" }));
  const editor = await screen.findByRole("region", { name: "조건식 편집" });

  fireEvent.click(within(editor).getByRole("button", { name: /^조건 추가$/ }));
  const addPop1 = await screen.findByRole("dialog", { name: "조건 추가" });
  fireEvent.change(within(addPop1).getByRole("textbox", { name: "조건 종류 검색" }), { target: { value: "프로그램 순매수" } });
  fireEvent.click(within(addPop1).getByRole("button", { name: "프로그램 순매수" }));

  fireEvent.click(within(editor).getByRole("button", { name: /^조건 추가$/ }));
  const addPop2 = await screen.findByRole("dialog", { name: "조건 추가" });
  fireEvent.change(within(addPop2).getByRole("textbox", { name: "조건 종류 검색" }), { target: { value: "신고가" } });
  fireEvent.click(within(addPop2).getByRole("button", { name: "신고가" }));

  fireEvent.click(within(editor).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(env.getDoc().screens).toHaveLength(1));

  fireEvent.click(within(editor).getAllByRole("button", { name: "실행" })[0]!);
  expect(await screen.findByText("가상교차급증")).toBeTruthy();
  expect(screen.getByText("+1,700백만")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "스크리너 열 설정" }));
  const colDialog = await screen.findByRole("dialog", { name: "스크리너 열 설정" });
  fireEvent.click(within(colDialog).getByRole("checkbox", { name: "거래대금" }));
  expect(screen.getByRole("columnheader", { name: "거래대금" })).toBeTruthy();

  const filterInput = screen.getByRole("searchbox", { name: "결과 내 검색" });
  fireEvent.change(filterInput, { target: { value: "없는종목" } });
  expect(screen.getByText("필터 조건에 맞는 종목이 없습니다")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
  expect(screen.getByText("가상교차급증")).toBeTruthy();
  expect(env.runBodies).toHaveLength(1);
  client.clear();
});
