// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { HeatmapBoard } from "../../api/generated/HeatmapBoard";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { HeatmapThemes } from "../../api/generated/HeatmapThemes";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { HeatmapPage } from "./HeatmapPage";

const NAMES: Record<string, string> = {
  "005930": "삼성전자",
  "000660": "SK하이닉스",
  "028260": "삼성물산",
  "086520": "에코프로",
};

const INITIAL_THEMES: HeatmapThemes = {
  revision: 100,
  themes: [
    { id: "chips", name: "반도체", symbols: ["005930", "000660"] },
    { id: "holding", name: "지주", symbols: ["028260", "086520"] },
  ],
};

function boardFrom(doc: HeatmapThemes): HeatmapBoard {
  return {
    revision: doc.revision,
    order: "rate",
    asOf: 1_794_186_000,
    source: "mine",
    catalog: null,
    themes: doc.themes.map((t) => ({
      id: t.id,
      name: t.name,
      summary: null,
      members: t.symbols.map((symbol) => ({
        symbol,
        name: NAMES[symbol] ?? symbol,
        price: 70_000,
        changeRate: 2.0,
        tradedMillionWon: 100_000,
      })),
      missing: [],
    })),
  };
}

function setupHeatmap(initial: HeatmapThemes = INITIAL_THEMES, options: { rejectPut?: boolean } = {}) {
  let doc: HeatmapThemes = structuredClone(initial);
  const puts: HeatmapThemes[] = [];
  const api = stubFetch(({ method, pathname, url, json }) => {
    if (pathname === "/api/heatmap/board") return { body: boardFrom(doc) };
    if (pathname === "/api/heatmap/themes") {
      if (method === "PUT") {
        const body = json() as HeatmapThemes;
        puts.push(body);
        if (options.rejectPut) {
          return { status: 500, body: { error: { code: "internal", message: "서버 저장 거부", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        if (body.revision <= doc.revision) {
          return { status: 409, body: { error: { code: "stale_revision", message: "경쟁 저장", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        doc = structuredClone(body);
        return { body: doc };
      }
      return { body: doc };
    }
    if (pathname === "/api/symbols") {
      const q = url.searchParams.get("q") ?? "";
      return {
        body: [
          { code: "086520", name: "에코프로", market: "kosdaq", listed: true, kind: "stock" },
          { code: "001", name: "코스피 지수", market: "kospi", listed: true, kind: "index" },
        ].filter((s) => s.name.includes(q) || s.code.includes(q)),
      };
    }
    return { body: {} };
  });

  return { api, puts, getDoc: () => doc, setDoc: (next: HeatmapThemes) => { doc = next; } };
}

beforeEach(() => {
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
  useWatchlistStore.setState({
    revision: 10,
    lists: [{
      id: "L",
      name: "히트맵용",
      symbols: ["005930", "028260"],
      groups: [{ id: "g1", name: "반도체", symbols: ["005930"] }, { id: "g2", name: "조선", symbols: ["028260"] }],
    }],
  });
});

resetDomAfterEach();

test("테마 추가·인라인 종목 검색·이름 바꾸기(Esc 취소)·삭제 확인 및 Ctrl+Z 되돌리기", async () => {
  const env = setupHeatmap();
  const { client } = renderWithProviders(<HeatmapPage />, { route: "/heatmap?view=list" });

  await screen.findByRole("region", { name: "반도체 목록" });
  fireEvent.click(screen.getByRole("button", { name: /^테마 추가$/ }));
  const input = await screen.findByRole("textbox", { name: "새 테마 이름" });
  fireEvent.change(input, { target: { value: "로봇" } });
  fireEvent.submit(input.closest("form")!);

  const robotRegion = await screen.findByRole("region", { name: "로봇 목록" });
  await waitFor(() => expect(env.getDoc().themes.map((t) => t.name)).toEqual(["반도체", "지주", "로봇"]));

  fireEvent.change(within(robotRegion).getByRole("searchbox", { name: "로봇 종목 검색" }), { target: { value: "에코프로" } });
  fireEvent.click(await within(robotRegion).findByRole("button", { name: /에코프로/ }));
  await waitFor(() => expect(env.getDoc().themes[2]!.symbols).toEqual(["086520"]));

  const chipRegion = screen.getByRole("region", { name: "반도체 목록" });
  fireEvent.click(within(chipRegion).getByRole("button", { name: "반도체 이름 바꾸기" }));
  const renameBox = within(chipRegion).getByRole("textbox", { name: "반도체 새 이름" });
  fireEvent.change(renameBox, { target: { value: "취소됨" } });
  fireEvent.keyDown(renameBox, { key: "Escape" });
  expect(env.getDoc().themes[0]!.name).toBe("반도체");

  fireEvent.click(within(chipRegion).getByRole("button", { name: "반도체 이름 바꾸기" }));
  const renameBox2 = within(chipRegion).getByRole("textbox", { name: "반도체 새 이름" });
  fireEvent.change(renameBox2, { target: { value: "반도체 소부장" } });
  fireEvent.keyDown(renameBox2, { key: "Enter" });
  await screen.findByRole("region", { name: "반도체 소부장 목록" });

  const holding = screen.getByRole("region", { name: "지주 목록" });
  fireEvent.click(within(holding).getByRole("button", { name: /^지주 지우기$/ }));
  fireEvent.click(within(holding).getByRole("button", { name: "지주 지우기 확인" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "지주 목록" })).toBeNull());

  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  expect(await screen.findByRole("region", { name: "지주 목록" })).toBeTruthy();
  client.clear();
});

test("이름 검증·60종목 상한·빈 상태 관심종목 가져오기(원본 불변)·서버 거부 롤백·충돌 리베이스", async () => {
  const fullTheme: HeatmapTheme = { id: "full", name: "가득", symbols: Array.from({ length: 60 }, (_, i) => String(100000 + i)) };
  const env = setupHeatmap({ revision: 100, themes: [fullTheme] });
  const view1 = renderWithProviders(<HeatmapPage />, { route: "/heatmap?view=list" });

  await screen.findByRole("region", { name: "가득 목록" });
  fireEvent.click(screen.getByRole("button", { name: /^테마 추가$/ }));
  const pop = await screen.findByRole("dialog", { name: "테마 추가" });
  const box = within(pop).getByRole("textbox", { name: "새 테마 이름" });
  fireEvent.change(box, { target: { value: "가득" } });
  fireEvent.submit(box.closest("form")!);
  expect(within(pop).getByRole("alert")).toBeTruthy();

  fireEvent.click(within(pop).getByRole("button", { name: /히트맵용/ }));
  await waitFor(() => expect(env.getDoc().themes.map((t) => t.name)).toEqual(["가득", "반도체", "조선"]));
  expect(useWatchlistStore.getState().lists[0]!.groups).toHaveLength(2);
  view1.client.clear();
  view1.unmount();

  setupHeatmap(INITIAL_THEMES, { rejectPut: true });
  const view2 = renderWithProviders(<HeatmapPage />, { route: "/heatmap?view=list" });
  const holding = await screen.findByRole("region", { name: "지주 목록" });
  fireEvent.click(within(holding).getByRole("button", { name: /^지주 지우기$/ }));
  fireEvent.click(within(holding).getByRole("button", { name: "지주 지우기 확인" }));
  await waitFor(() => expect(screen.getByText(/테마를 저장하지 못했습니다/)).toBeTruthy());
  expect(screen.getByRole("region", { name: "지주 목록" })).toBeTruthy();
  view2.client.clear();
  view2.unmount();

  const envEmpty = setupHeatmap({ revision: 50, themes: [] });
  const view3 = renderWithProviders(<HeatmapPage />, { route: "/heatmap?view=list" });
  fireEvent.click(await screen.findByRole("button", { name: "테마 직접 만들기" }));
  const emptyInput = screen.getByRole("textbox", { name: "새 테마 이름" });
  fireEvent.change(emptyInput, { target: { value: "신규" } });
  fireEvent.submit(emptyInput.closest("form")!);
  await waitFor(() => expect(envEmpty.getDoc().themes.map((t) => t.name)).toEqual(["신규"]));

  envEmpty.setDoc({ revision: 55, themes: [...envEmpty.getDoc().themes, { id: "ext", name: "타인추가", symbols: [] }] });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^테마 추가$/ }));
  });
  const addBox = await screen.findByRole("textbox", { name: "새 테마 이름" });
  fireEvent.change(addBox, { target: { value: "두번째" } });
  fireEvent.submit(addBox.closest("form")!);
  await waitFor(() => expect(envEmpty.getDoc().themes.map((t) => t.name)).toContain("타인추가"));
  expect(envEmpty.getDoc().themes.map((t) => t.name)).toContain("두번째");
  view3.client.clear();
});
