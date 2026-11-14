import { afterEach, expect, test, vi } from "vitest";
import type { Layout } from "../api/generated/Layout";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import { ApiRequestError } from "../api/http";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { chartWindows, DEFAULT_LAYOUT } from "../stores/layout";
import type { SaveTarget } from "../stores/persist";
import { NXT_FALLBACK_NOTICE, restore, type RestoreSources } from "./restore";
import type { Unsaved } from "./saver";

const SERVER_LISTS = [
  { id: "W1", name: "기본", symbols: ["005930", "IDX:001"], groups: [] },
  { id: "W2", name: "반도체", symbols: ["000660"], groups: [] },
];
const LOCAL_LISTS = [{ id: "W1", name: "기본", symbols: ["000660"], groups: [] }];

afterEach(() => vi.restoreAllMocks());

const info = (code: string, nxtEnabled: boolean): SymbolInfo => ({ code, name: code, kind: "common", market: "kospi", nxtEnabled });
const INFOS: Record<string, SymbolInfo> = { "005930": info("005930", true), "005935": info("005935", false) };

type ChartWindow = Extract<LayoutWindow, { kind: "chart" }>;
const cell = (over: Partial<ChartWindow>): ChartWindow => ({
  id: "cell-0",
  link: null,
  kind: "chart",
  symbol: "005930",
  venue: "combined",
  period: "D",
  chartSettings: DEFAULT_CHART_SETTINGS,
  ...over,
});
const SIDE_WINDOWS: LayoutWindow[] = [
  { id: "watchlist", link: null, kind: "watchlist" },
  { id: "screener", link: null, kind: "screener" },
  { id: "objects", link: null, kind: "objects" },
];
const SYNC = { crosshair: true, scroll: true };
const layout = (id: string, ...cells: ChartWindow[]): Layout => ({ id, name: id, sync: SYNC, windows: [...cells, ...SIDE_WINDOWS], placement: {}, updatedAt: 1, revision: 10 });

function sources(
  opts: { lastLayoutId?: string | null; layouts?: Layout[]; symbolInfo?: RestoreSources["symbolInfo"]; unsaved?: Partial<Record<SaveTarget, Unsaved>> } = {},
): RestoreSources {
  const layouts = opts.layouts ?? [layout("L1", cell({}))];
  return {
    uiState: async () => ({ lastLayoutId: opts.lastLayoutId === undefined ? "L1" : opts.lastLayoutId, theme: "light", extraKey: 1, revision: 20 }),
    layouts: async () => layouts.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
    layout: async (id) => {
      const l = layouts.find((x) => x.id === id);
      if (!l) throw new ApiRequestError("not_found", "없음");
      return l;
    },
    watchlists: async () => ({ lists: SERVER_LISTS, revision: 30 }),
    unsaved: (target) => opts.unsaved?.[target] ?? null,
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
  expect(chartWindows(r.layout)[0]).toMatchObject({ symbol: "005930", venue: "nxt", chartSettings: DEFAULT_CHART_SETTINGS });
  expect(r.layoutDirty).toBe(false);
  expect(r.uiDirty).toBe(false);
  expect(r.ui.prefs.theme).toBe("dark");
  expect(r.ui.extra).toEqual({ extraKey: 1 });
  expect(r.watchlists).toEqual(SERVER_LISTS);
  expect(r.notices).toEqual([]);
  expect(r.revisions).toEqual({ layout: 10, ui: 20, watchlist: 30 });
  expect(r.ui.extra).not.toHaveProperty("revision");
});

const unsaved = (path: string, revision: number, value: object): Unsaved => ({ path, revision, body: JSON.stringify({ ...value, revision }) });

test("R2: 지난 페이지가 남긴 미저장 본문이 서버 것보다 새로우면 그것을 열고 다시 저장한다", async () => {
  const stored = layout("L1", cell({ period: "D" }));
  const { updatedAt: _, revision: _r, ...input } = { ...stored, windows: [cell({ period: "M" }), ...SIDE_WINDOWS] };
  const r = await restore(
    sources({
      layouts: [stored],
      unsaved: {
        layout: unsaved("/api/layouts/L1", 11, input),
        ui: unsaved("/api/ui-state", 21, { lastLayoutId: "L1", theme: "dark", extraKey: 2 }),
        watchlist: unsaved("/api/watchlists", 31, { lists: LOCAL_LISTS }),
      },
    }),
  );
  expect(chartWindows(r.layout)[0]!.period).toBe("M");
  expect(r.ui.prefs.theme).toBe("dark");
  expect(r.ui.extra).toEqual({ extraKey: 2 });
  expect(r.watchlists).toEqual(LOCAL_LISTS);
  expect([r.layoutDirty, r.uiDirty, r.watchlistDirty]).toEqual([true, true, true]);
  expect(r.revisions).toEqual({ layout: 11, ui: 21, watchlist: 31 });
  expect(r.serverRevisions).toEqual({ layout: 10, ui: 20, watchlist: 30 });
});

test("칸 배치 모양(arrangement·cells)으로 남은 미저장 본문은 버리고 서버 레이아웃을 연다", async () => {
  const old = { id: "L1", name: "L1", arrangement: "1", sync: SYNC, cells: [{ slot: 0, symbol: "005930", venue: "combined", period: "M", symbolLink: false, chartSettings: DEFAULT_CHART_SETTINGS }] };
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, old) } }));
  expect(chartWindows(r.layout).map((w) => w.period)).toEqual(["D"]);
  expect(r.layout).not.toHaveProperty("cells");
  expect(r.layoutDirty).toBe(false);
  expect(r.revisions.layout).toBe(10);
});

test("창 목록이 있어도 placement가 객체가 아닌 미저장 본문은 열지 않는다", async () => {
  const { updatedAt: _, revision: _r, ...input } = { ...layout("L1", cell({ period: "M" })), placement: [] };
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, input) } }));
  expect(chartWindows(r.layout)[0]!.period).toBe("D");
  expect(r.layoutDirty).toBe(false);
});

test.each([
  ["차트 창이 없다", [{ id: "watchlist", link: null, kind: "watchlist" }]],
  ["창이 없다", []],
  ["창 id가 형식에 맞지 않는다", [{ id: "칸 1", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "M", chartSettings: {} }]],
  ["창 id가 겹친다", [{ id: "a", link: null, kind: "watchlist" }, { id: "a", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "M", chartSettings: {} }]],
  ["모르는 종류가 있다", [{ id: "c", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "M", chartSettings: {} }, { id: "x", link: null, kind: "nope" }]],
  ["차트 창에 종목이 없다", [{ id: "c", link: null, kind: "chart", venue: "combined", period: "M", chartSettings: {} }]],
  ["연동 색이 틀렸다", [{ id: "c", link: "d", kind: "chart", symbol: "005930", venue: "combined", period: "M", chartSettings: {} }]],
  ["관심종목 창이 둘이다", [{ id: "c", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "M", chartSettings: {} }, { id: "w1", link: null, kind: "watchlist" }, { id: "w2", link: null, kind: "watchlist" }]],
])("%s면 미저장 본문을 버리고 서버 레이아웃을 연다", async (_, windows) => {
  const draft = { id: "L1", name: "L1", sync: SYNC, windows, placement: {} };
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draft) } }));
  expect(chartWindows(r.layout).map((w) => w.period)).toEqual(["D"]);
  expect(r.layoutDirty).toBe(false);
});

test("차트가 아닌 창과 배치를 순서·연동 색 그대로 열고, 마이그레이션이 남긴 빈 배치는 경고 없이 읽는다", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const windows: LayoutWindow[] = [cell({ id: "cell-0", link: "a" }), { id: "watchlist", link: "a", kind: "watchlist" }, cell({ id: "cell-1", symbol: "IDX:001", venue: null }), ...SIDE_WINDOWS.slice(1)];
  const stored: Layout = { ...layout("L1"), windows };
  const r = await restore(sources({ layouts: [stored] }));
  expect(r.layout.windows.map((w) => [w.id, w.kind, w.link])).toEqual([
    ["cell-0", "chart", "a"],
    ["watchlist", "watchlist", "a"],
    ["cell-1", "chart", null],
    ["screener", "screener", null],
    ["objects", "objects", null],
  ]);
  expect(r.layout.placement).toEqual({ v: 1, dock: null, canvas: null });
  expect(warn).not.toHaveBeenCalled();
  expect(r.layoutDirty).toBe(false);
});

test("배치는 읽어 둔 모양으로 연다", async () => {
  const canvas = { rects: { "cell-0": { x: 0, y: 0, w: 0.7, h: 1 }, watchlist: { x: 0.7, y: 0, w: 0.3, h: 1 } }, order: ["cell-0", "watchlist"] };
  const r = await restore(sources({ layouts: [{ ...layout("L1", cell({})), placement: { v: 1, dock: null, canvas } }] }));
  expect(r.layout.placement).toEqual({ v: 1, dock: null, canvas });
});

test("배포 전 경로(/api/watchlist)의 미저장 본문이나 목록 모양이 아닌 본문은 열지 않는다", async () => {
  for (const u of [unsaved("/api/watchlist", 99, { symbols: ["000660"] }), unsaved("/api/watchlists", 99, { lists: [] })]) {
    const r = await restore(sources({ unsaved: { watchlist: u } }));
    expect([r.watchlists, r.watchlistDirty, r.revisions.watchlist]).toEqual([SERVER_LISTS, false, 30]);
  }
});

test("R2: 서버가 이미 가진 것(같거나 큰 revision)이나 다른 레이아웃의 미저장 본문은 열지 않는다", async () => {
  const r = await restore(
    sources({
      unsaved: {
        layout: unsaved("/api/layouts/OTHER", 99, { id: "OTHER" }),
        ui: unsaved("/api/ui-state", 20, { lastLayoutId: "L1", theme: "dark" }),
        watchlist: unsaved("/api/watchlists", 5, { lists: LOCAL_LISTS }),
      },
    }),
  );
  expect(r.ui.prefs.theme).toBe("dark");
  expect(r.watchlists).toEqual(SERVER_LISTS);
  expect([r.layoutDirty, r.uiDirty, r.watchlistDirty]).toEqual([false, false, false]);
  expect(r.revisions).toEqual({ layout: 10, ui: 20, watchlist: 30 });
});

test("NXT 불가 종목에 NXT가 저장돼 있으면 통합으로 열고, 고친 값을 저장하고, 알린다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "005935", venue: "nxt" }))] }));
  expect(chartWindows(r.layout)[0]!.venue).toBe("combined");
  expect(r.layoutDirty).toBe(true);
  expect(r.notices).toEqual([NXT_FALLBACK_NOTICE]);
});

test("종목 정보를 잠깐 못 받으면 저장된 NXT를 그대로 둔다(통합은 그릴 때만 쓴다)", async () => {
  const r = await restore(
    sources({
      layouts: [layout("L1", cell({ venue: "nxt" }))],
      symbolInfo: async () => Promise.reject(new ApiRequestError("kiwoom_unavailable", "잠시 뒤")),
    }),
  );
  expect(chartWindows(r.layout)[0]!.venue).toBe("nxt");
  expect(r.layoutDirty).toBe(false);
  expect(r.notices).toEqual([]);
});

test("한 칸의 확인된 NXT 불가를 고쳐 저장해도, 확인하지 못한 다른 칸의 NXT는 그대로다", async () => {
  const two = layout("L1", cell({ id: "cell-0", symbol: "005935", venue: "nxt" }), cell({ id: "cell-1", symbol: "000660", venue: "nxt" }));
  const r = await restore(
    sources({
      layouts: [two],
      symbolInfo: async (code) => {
        if (code === "005935") return INFOS["005935"]!;
        throw new ApiRequestError("kiwoom_unavailable", "잠시 뒤");
      },
    }),
  );
  expect(chartWindows(r.layout).map((c) => c.venue)).toEqual(["combined", "nxt"]);
  expect(r.layoutDirty).toBe(true);
  expect(r.notices).toEqual([NXT_FALLBACK_NOTICE]);
});

test("종목 정보를 잠깐 못 받아도 KRX는 그대로 연다", async () => {
  const r = await restore(
    sources({ layouts: [layout("L1", cell({ venue: "krx" }))], symbolInfo: async () => Promise.reject(new ApiRequestError("network", "x")) }),
  );
  expect(chartWindows(r.layout)[0]!.venue).toBe("krx");
  expect(r.layoutDirty).toBe(false);
});

test("없는 종목이면 칸을 그대로 둔다(칸이 오류를 보인다)", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "999999", venue: "nxt" }))] }));
  expect(chartWindows(r.layout)[0]).toMatchObject({ symbol: "999999", venue: "nxt" });
  expect(r.layoutDirty).toBe(false);
});

test("지수 칸은 거래소 없이 연다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "IDX:001", venue: null }))] }));
  expect(chartWindows(r.layout)[0]!.venue).toBeNull();
  expect(r.layoutDirty).toBe(false);
});

test("chartSettings 모양이 틀리면 기본 설정으로 연다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const r = await restore(sources({ layouts: [layout("L1", cell({ chartSettings: { style: "nope" } }))] }));
  expect(chartWindows(r.layout)[0]!.chartSettings).toEqual(DEFAULT_CHART_SETTINGS);
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
