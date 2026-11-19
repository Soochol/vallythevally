import { afterEach, expect, test, vi } from "vitest";
import type { Layout } from "../api/generated/Layout";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import { ApiRequestError } from "../api/http";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { chartWindows, DEFAULT_LAYOUT } from "../stores/layout";
import type { SaveTarget } from "../stores/persist";
import { restore, type RestoreSources } from "./restore";
import type { Unsaved } from "./saver";

const SERVER_LISTS = [
  { id: "W1", name: "기본", symbols: ["005930", "IDX:001"], groups: [] },
  { id: "W2", name: "반도체", symbols: ["000660"], groups: [] },
];
const LOCAL_LISTS = [{ id: "W1", name: "기본", symbols: ["000660"], groups: [] }];

afterEach(() => vi.restoreAllMocks());

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
];
const SYNC = { crosshair: true, scroll: true, crosshairScope: "all" } as const;
const layout = (id: string, ...cells: ChartWindow[]): Layout => ({ id, name: id, sync: SYNC, windows: [...cells, ...SIDE_WINDOWS], placement: {}, updatedAt: 1, revision: 10 });

function sources(
  opts: { lastLayoutId?: string | null; layouts?: Layout[]; unsaved?: Partial<Record<SaveTarget, Unsaved>> } = {},
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
  };
}

test("저장된 값을 그대로 열면 아무것도 저장하지 않는다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({}))] }));
  expect(chartWindows(r.layout)[0]).toMatchObject({ symbol: "005930", chartSettings: DEFAULT_CHART_SETTINGS });
  expect(r.layoutDirty).toBe(false);
  expect(r.uiDirty).toBe(false);
  expect(r.ui.prefs.theme).toBe("dark");
  expect(r.ui.extra).toEqual({ extraKey: 1 });
  expect(r.watchlists).toEqual(SERVER_LISTS);
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
  ["연동 색이 틀렸다", [{ id: "c", link: "k", kind: "chart", symbol: "005930", venue: "combined", period: "M", chartSettings: {} }]],
  ["지표 창이 둘이다", [{ id: "c", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "M", chartSettings: {} }, { id: "i1", link: null, kind: "indicators" }, { id: "i2", link: null, kind: "indicators" }]],
])("%s면 미저장 본문을 버리고 서버 레이아웃을 연다", async (_, windows) => {
  const draft = { id: "L1", name: "L1", sync: SYNC, windows, placement: {} };
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draft) } }));
  expect(chartWindows(r.layout).map((w) => w.period)).toEqual(["D"]);
  expect(r.layoutDirty).toBe(false);
});

test("십자선 연동 범위가 없는 옛 미저장 본문은 서버 레이아웃의 범위를 이어받는다", async () => {
  const draft = { id: "L1", name: "L1", sync: { crosshair: false, scroll: true }, windows: [{ id: "cell-0", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "W", chartSettings: {} }], placement: {} };
  const r = await restore(sources({ layouts: [{ ...layout("L1"), sync: { ...SYNC, crosshairScope: "symbol" } }], unsaved: { layout: unsaved("/api/layouts/L1", 11, draft) } }));
  expect(r.layout.sync).toEqual({ crosshair: false, scroll: true, crosshairScope: "symbol" });
});

test("옛 미저장 본문의 개체 목록 창은 그 창만 빼고 열고 다시 저장한다", async () => {
  const chart = { id: "cell-0", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "W", chartSettings: {} };
  const draft = { id: "L1", name: "L1", sync: SYNC, windows: [chart, { id: "watchlist", link: null, kind: "watchlist" }, { id: "objects", link: null, kind: "objects" }], placement: {} };
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draft) } }));
  expect(r.layout.windows.map((w) => w.kind)).toEqual(["chart", "watchlist"]);
  expect(chartWindows(r.layout)[0]).toMatchObject({ symbol: "000660", period: "W" });
  expect([r.layoutDirty, r.revisions.layout]).toEqual([true, 11]);
});

test("개체 목록 창을 빼도 모르는 다른 종류가 남아 있으면 미저장 본문을 버린다", async () => {
  const chart = { id: "cell-0", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "W", chartSettings: {} };
  const draft = { id: "L1", name: "L1", sync: SYNC, windows: [chart, { id: "objects", link: null, kind: "objects" }, { id: "x", link: null, kind: "nope" }], placement: {} };
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draft) } }));
  expect(chartWindows(r.layout).map((w) => w.period)).toEqual(["D"]);
  expect(r.layoutDirty).toBe(false);
});

const draftWith = (...windows: unknown[]) => ({ id: "L1", name: "L1", sync: SYNC, windows: [{ id: "cell-0", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "W", chartSettings: {} }, ...windows], placement: {} });

test("같은 종류 창 둘이 든 미저장 본문은 그대로 열고 연동 색을 각자 지킨다", async () => {
  const draft = draftWith({ id: "trades", link: "a", kind: "trades" }, { id: "trades-2", link: "b", kind: "trades" }, { id: "order", link: null, kind: "order", venue: "krx" }, { id: "order-2", link: "a", kind: "order", venue: "nxt" }, { id: "watchlist", link: null, kind: "watchlist" }, { id: "watchlist-2", link: null, kind: "watchlist" });
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draft) } }));
  expect(r.layout.windows.map((w) => [w.id, w.link])).toEqual([["cell-0", null], ["trades", "a"], ["trades-2", "b"], ["order", null], ["order-2", "a"], ["watchlist", null], ["watchlist-2", null]]);
  expect(r.layout.windows.find((w) => w.id === "order-2")).toMatchObject({ venue: "nxt" });
  expect([r.layoutDirty, r.revisions.layout]).toEqual([true, 11]);
});

test("창별 상태 셋은 서버 레이아웃과 미저장 본문에서 읽고 비어 있으면 필드를 두지 않는다", async () => {
  const stored: Layout = { ...layout("L1", cell({})), windows: [cell({}), { id: "watchlist", link: null, kind: "watchlist", list: "W2" }, { id: "screener", link: null, kind: "screener" }, { id: "book", link: "a", kind: "book", symbol: "000660" }, { id: "order", link: null, kind: "order", venue: "nxt", symbol: "0000D0" }, { id: "trades", link: null, kind: "trades" }] };
  const server = await restore(sources({ layouts: [stored] }));
  expect(server.layout.windows.slice(1)).toEqual([
    { id: "watchlist", link: null, kind: "watchlist", list: "W2" },
    { id: "screener", link: null, kind: "screener" },
    { id: "book", link: "a", kind: "book", symbol: "000660" },
    { id: "order", link: null, kind: "order", venue: "nxt", symbol: "0000D0" },
    { id: "trades", link: null, kind: "trades" },
  ]);
  const draft = draftWith({ id: "watchlist", link: null, kind: "watchlist", list: null }, { id: "screener", link: null, kind: "screener", screen: "S2" }, { id: "program", link: null, kind: "program", symbol: "005930" }, { id: "brokers", link: null, kind: "brokers", symbol: null });
  const local = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draft) } }));
  expect(local.layout.windows.slice(1)).toEqual([
    { id: "watchlist", link: null, kind: "watchlist" },
    { id: "screener", link: null, kind: "screener", screen: "S2" },
    { id: "program", link: null, kind: "program", symbol: "005930" },
    { id: "brokers", link: null, kind: "brokers" },
  ]);
  expect(local.layoutDirty).toBe(true);
});

test.each([
  ["지수 종목", { id: "trades", link: null, kind: "trades", symbol: "IDX:001" }],
  ["여섯 자리가 아닌 종목", { id: "book", link: null, kind: "book", symbol: "5930" }],
  ["문자열이 아닌 종목", { id: "program", link: null, kind: "program", symbol: 5930 }],
  ["호가주문의 지수 종목", { id: "order", link: null, kind: "order", venue: "krx", symbol: "IDX:101" }],
  ["문자열이 아닌 list", { id: "watchlist", link: null, kind: "watchlist", list: 7 }],
  ["빈 list", { id: "watchlist", link: null, kind: "watchlist", list: "" }],
  ["순위 설정이 없는 순위 창", { id: "ranking", link: null, kind: "ranking" }],
  ["모르는 순위 종류", { id: "ranking", link: null, kind: "ranking", ranking: { kind: "nope" } }],
  ["객체가 아닌 순위 설정", { id: "ranking", link: null, kind: "ranking", ranking: "tradeAmount" }],
  ["필드가 빠진 순위 설정", { id: "ranking", link: null, kind: "ranking", ranking: { kind: "tradeAmount" } }],
  ["모르는 시장의 순위 설정", { id: "ranking", link: null, kind: "ranking", ranking: { kind: "tradeAmount", market: "zzz", venue: "krx", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } }],
  ["시장이 전체인 프로그램 순위", { id: "ranking", link: null, kind: "ranking", ranking: { kind: "program", market: "all", venue: "krx", direction: "netBuy", excludes: { etfEtn: true, preferred: false } } }],
  ["문자열이 아닌 screen", { id: "screener", link: null, kind: "screener", screen: ["S1"] }],
  ["64바이트를 넘는 screen", { id: "screener", link: null, kind: "screener", screen: "x".repeat(65) }],
])("%s가 든 미저장 본문은 열지 않고 서버 레이아웃을 연다", async (_, bad) => {
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draftWith(bad)) } }));
  expect(chartWindows(r.layout).map((w) => w.period)).toEqual(["D"]);
  expect(r.layoutDirty).toBe(false);
});

test("순위 창 둘이 든 서버 레이아웃과 미저장 본문은 순위 설정을 그대로 연다", async () => {
  const excludes = { etfEtn: true, preferred: false };
  const first = { id: "ranking", link: "a", kind: "ranking", ranking: { kind: "tradeAmount", market: "all", venue: "krx", excludes, excludeManaged: false } } as const;
  const second = { id: "ranking-2", link: null, kind: "ranking", ranking: { kind: "program", market: "kospi", venue: "nxt", direction: "netSell", excludes } } as const;
  const stored: Layout = { ...layout("L1", cell({})), windows: [cell({}), first, second] };
  const server = await restore(sources({ layouts: [stored] }));
  expect(server.layout.windows.slice(1)).toEqual([first, second]);
  const local = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draftWith(first, second)) } }));
  expect(local.layout.windows.slice(1)).toEqual([first, second]);
  expect([local.layoutDirty, local.revisions.layout]).toEqual([true, 11]);
});

test("지표 창이 둘 든 미저장 본문은 열지 않는다", async () => {
  const r = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draftWith({ id: "indicators", link: null, kind: "indicators" }, { id: "indicators-2", link: null, kind: "indicators" })) } }));
  expect(chartWindows(r.layout).map((w) => w.period)).toEqual(["D"]);
  expect(r.layoutDirty).toBe(false);
});

test("창이 50개인 미저장 본문은 열고 51개는 열지 않는다", async () => {
  const trades = (count: number) => Array.from({ length: count }, (_, n) => ({ id: `trades-${n}`, link: null, kind: "trades" }));
  const full = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draftWith(...trades(49))) } }));
  expect(full.layout.windows).toHaveLength(50);
  expect(full.layoutDirty).toBe(true);
  const over = await restore(sources({ unsaved: { layout: unsaved("/api/layouts/L1", 11, draftWith(...trades(50))) } }));
  expect(over.layout.windows).toHaveLength(3);
  expect(over.layoutDirty).toBe(false);
});

test("차트가 아닌 창과 배치를 순서·연동 색 그대로 열고, 마이그레이션이 남긴 빈 배치는 경고 없이 읽는다", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const windows: LayoutWindow[] = [cell({ id: "cell-0", link: "a" }), { id: "watchlist", link: "j", kind: "watchlist" }, cell({ id: "cell-1", symbol: "IDX:001", venue: null }), ...SIDE_WINDOWS.slice(1)];
  const stored: Layout = { ...layout("L1"), windows };
  const r = await restore(sources({ layouts: [stored] }));
  expect(r.layout.windows.map((w) => [w.id, w.kind, w.link])).toEqual([
    ["cell-0", "chart", "a"],
    ["watchlist", "watchlist", "j"],
    ["cell-1", "chart", null],
    ["screener", "screener", null],
  ]);
  expect(r.layout.placement).toEqual({ v: 1, dock: null, canvas: null });
  expect(warn).not.toHaveBeenCalled();
  expect(r.layoutDirty).toBe(false);
});

test("같은 연동 색인데 종목이 다른 차트 창은 창 목록에서 앞선 창의 종목으로 맞춰 열고 저장한다", async () => {
  const windows: LayoutWindow[] = [
    cell({ id: "cell-0", link: "b", symbol: "IDX:001", venue: null }),
    cell({ id: "cell-1", link: "a", symbol: "005930", venue: "krx", period: "W" }),
    cell({ id: "cell-2", link: "a", symbol: "005935", venue: "combined", period: "D" }),
    cell({ id: "cell-3", link: "b", symbol: "005935", venue: "combined" }),
    cell({ id: "cell-4", link: null, symbol: "005935", venue: "combined" }),
    cell({ id: "cell-5", link: "a", symbol: "000660", venue: "nxt" }),
    ...SIDE_WINDOWS,
  ];
  const r = await restore(sources({ layouts: [{ ...layout("L1"), windows }] }));
  expect(chartWindows(r.layout).map((w) => [w.id, w.symbol, w.period])).toEqual([
    ["cell-0", "IDX:001", "D"],
    ["cell-1", "005930", "W"],
    ["cell-2", "005930", "D"],
    ["cell-3", "IDX:001", "D"],
    ["cell-4", "005935", "D"],
    ["cell-5", "005930", "D"],
  ]);
  expect(r.layoutDirty).toBe(true);
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

test("칸마다 저장돼 있던 거래소는 읽지 않는다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "005935", venue: "nxt" }), cell({ id: "cell-1", symbol: "IDX:001", venue: null }))] }));
  for (const w of chartWindows(r.layout)) expect(w).not.toHaveProperty("venue");
  expect(r.layoutDirty).toBe(false);
});

test("종목 정보를 받지 않고 연다", async () => {
  const r = await restore(sources({ layouts: [layout("L1", cell({ symbol: "999999", venue: "nxt" }))] }));
  expect(chartWindows(r.layout)[0]).toMatchObject({ symbol: "999999" });
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
