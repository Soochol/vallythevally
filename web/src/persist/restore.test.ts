import { afterEach, expect, test, vi } from "vitest";
import type { Cell } from "../api/generated/Cell";
import type { Layout } from "../api/generated/Layout";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import { ApiRequestError } from "../api/http";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { DEFAULT_LAYOUT } from "../stores/layout";
import { NXT_FALLBACK_NOTICE, restore, type RestoreSources } from "./restore";

afterEach(() => vi.restoreAllMocks());

const info = (code: string, nxtEnabled: boolean): SymbolInfo => ({ code, name: code, kind: "common", market: "kospi", nxtEnabled });
const INFOS: Record<string, SymbolInfo> = { "005930": info("005930", true), "005935": info("005935", false) };

const cell = (over: Partial<Cell>): Cell => ({
  slot: 0,
  symbol: "005930",
  venue: "combined",
  period: "D",
  symbolLink: false,
  chartSettings: DEFAULT_CHART_SETTINGS,
  ...over,
});
const layout = (id: string, c: Cell): Layout => ({ id, name: id, arrangement: "1", sync: { crosshair: true, scroll: true }, cells: [c], updatedAt: 1 });

function sources(opts: { lastLayoutId?: string | null; layouts?: Layout[]; symbolInfo?: RestoreSources["symbolInfo"] } = {}): RestoreSources {
  const layouts = opts.layouts ?? [layout("L1", cell({}))];
  return {
    uiState: async () => ({ lastLayoutId: opts.lastLayoutId === undefined ? "L1" : opts.lastLayoutId, theme: "light", extraKey: 1 }),
    layouts: async () => layouts.map(({ id, name, arrangement, updatedAt }) => ({ id, name, arrangement, updatedAt })),
    layout: async (id) => {
      const l = layouts.find((x) => x.id === id);
      if (!l) throw new ApiRequestError("not_found", "없음");
      return l;
    },
    watchlist: async () => ({ symbols: ["005930", "IDX:001"] }),
    symbolInfo:
      opts.symbolInfo ??
      (async (code) => {
        const i = INFOS[code];
        if (!i) throw new ApiRequestError("unknown_symbol", "없음");
        return i;
      }),
  };
}

test("저장된 값을 그대로 열면 아무것도 저장하지 않는다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ venue: "nxt" }))] }));
  expect(r.layout.cells[0]).toMatchObject({ symbol: "005930", venue: "nxt", chartSettings: DEFAULT_CHART_SETTINGS });
  expect(r.layoutDirty).toBe(false);
  expect(r.uiDirty).toBe(false);
  expect(r.ui.prefs.theme).toBe("light");
  expect(r.ui.extra).toEqual({ extraKey: 1 });
  expect(r.watchlist).toEqual(["005930", "IDX:001"]);
  expect(r.notices).toEqual([]);
});

test("NXT 불가 종목에 NXT가 저장돼 있으면 통합으로 열고, 고친 값을 저장하고, 알린다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "005935", venue: "nxt" }))] }));
  expect(r.layout.cells[0]!.venue).toBe("combined");
  expect(r.layoutDirty).toBe(true);
  expect(r.notices).toEqual([NXT_FALLBACK_NOTICE]);
});

test("종목 정보를 잠깐 못 받으면 NXT를 통합으로 열되 저장된 값은 덮어쓰지 않는다", async () => {
  const r = await restore(
    sources({
      layouts: [layout("L1", cell({ venue: "nxt" }))],
      symbolInfo: async () => Promise.reject(new ApiRequestError("kiwoom_unavailable", "잠시 뒤")),
    }),
  );
  expect(r.layout.cells[0]!.venue).toBe("combined");
  expect(r.layoutDirty).toBe(false);
  expect(r.notices).toEqual([]);
});

test("종목 정보를 잠깐 못 받아도 KRX는 그대로 연다", async () => {
  const r = await restore(
    sources({ layouts: [layout("L1", cell({ venue: "krx" }))], symbolInfo: async () => Promise.reject(new ApiRequestError("network", "x")) }),
  );
  expect(r.layout.cells[0]!.venue).toBe("krx");
  expect(r.layoutDirty).toBe(false);
});

test("없는 종목이면 칸을 그대로 둔다(칸이 오류를 보인다)", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "999999", venue: "nxt" }))] }));
  expect(r.layout.cells[0]).toMatchObject({ symbol: "999999", venue: "nxt" });
  expect(r.layoutDirty).toBe(false);
});

test("지수 칸은 거래소 없이 연다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "IDX:001", venue: null }))] }));
  expect(r.layout.cells[0]!.venue).toBeNull();
  expect(r.layoutDirty).toBe(false);
});

test("chartSettings 모양이 틀리면 기본 설정으로 연다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const r = await restore(sources({ layouts: [layout("L1", cell({ chartSettings: { style: "nope" } }))] }));
  expect(r.layout.cells[0]!.chartSettings).toEqual(DEFAULT_CHART_SETTINGS);
});

test.each([
  ["없는 id", "gone"],
  ["null", null],
])("lastLayoutId가 %s면 목록의 첫 레이아웃을 열고 lastLayoutId를 고친다", async (_, lastLayoutId) => {
  const r = await restore(sources({ lastLayoutId, layouts: [layout("L2", cell({})), layout("L3", cell({}))] }));
  expect(r.layout.id).toBe("L2");
  expect(r.uiDirty).toBe(true);
  expect(r.ui.prefs.lastLayoutId).toBe("L2");
});

test("레이아웃이 하나도 없으면 기본 레이아웃을 만들어 저장한다", async () => {
  const r = await restore(sources({ layouts: [] }));
  expect(r.layout).toEqual(DEFAULT_LAYOUT);
  expect(r.layoutDirty).toBe(true);
});

test("사용자 자료를 읽지 못하면 던진다", async () => {
  const src = sources();
  src.uiState = async () => Promise.reject(new ApiRequestError("network", "서버에 연결하지 못했습니다"));
  await expect(restore(src)).rejects.toMatchObject({ code: "network" });
});
