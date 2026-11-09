import type { ApiErrorCode } from "../src/api/generated/ApiErrorCode.ts";
import type { Layout } from "../src/api/generated/Layout.ts";
import type { LayoutInput } from "../src/api/generated/LayoutInput.ts";
import type { LayoutSummary } from "../src/api/generated/LayoutSummary.ts";
import type { Watchlist } from "../src/api/generated/Watchlist.ts";
import type { Watchlists } from "../src/api/generated/Watchlists.ts";

export const PAYLOAD_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_LAYOUT_ID = "01900000-0000-7000-8000-000000000001";
export const FIRST_WATCHLIST_ID = "01900000-0000-7000-8000-000000000002";
const MAX_WATCHLISTS = 20;
const MAX_WATCHLIST_NAME = 20;
const CELLS_OF = { "1": 1, "2h": 2, "2v": 2, "3": 3, "4": 4 } as const;

export type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, code: ApiErrorCode, message: string): Reply => ({ status, body: { error: { code, message } } });
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isRevision = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
const isWatchlist = (x: unknown): x is Watchlist =>
  isObject(x) && typeof x.id === "string" && typeof x.name === "string" && Array.isArray(x.symbols) && x.symbols.every((s) => typeof s === "string");
const stale = (stored: number) => fail(409, "stale_revision", `더 새 편집(revision ${stored})이 이미 저장돼 있습니다`);

export function createUserData(seedWatchlist: string[], nowSec: () => number = () => Math.floor(Date.now() / 1000)) {
  const layouts = new Map<string, Layout>([
    [
      DEFAULT_LAYOUT_ID,
      {
        id: DEFAULT_LAYOUT_ID,
        name: "기본",
        arrangement: "1",
        sync: { crosshair: true, scroll: true },
        cells: [
          {
            slot: 0,
            symbol: "IDX:001",
            venue: null,
            period: "D",
            symbolLink: false,
            chartSettings: { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] },
          },
        ],
        updatedAt: 0,
        revision: 0,
      },
    ],
  ]);
  let uiState: Record<string, unknown> = { lastLayoutId: DEFAULT_LAYOUT_ID, theme: "dark", revision: 0 };
  let watchlists: Watchlists = { lists: [{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: [...seedWatchlist] }], revision: 0 };

  return {
    listLayouts: (): Reply =>
      ok([...layouts.values()].map(({ id, name, arrangement, updatedAt }): LayoutSummary => ({ id, name, arrangement, updatedAt }))),
    getLayout: (id: string): Reply => {
      const l = layouts.get(id);
      return l ? ok(l) : fail(404, "not_found", `레이아웃 ${id}이 없습니다`);
    },
    putLayout: (id: string, body: unknown): Reply => {
      if (!isObject(body) || !Array.isArray(body.cells)) return fail(400, "bad_request", "레이아웃 본문이 아닙니다");
      const input = body as LayoutInput;
      if (input.id !== id) return fail(400, "bad_request", "주소의 id와 본문의 id가 다릅니다");
      if (!isRevision(input.revision)) return fail(400, "bad_request", "revision이 없습니다");
      if (input.cells.length !== CELLS_OF[input.arrangement]) return fail(400, "bad_request", "칸 수가 배치와 맞지 않습니다");
      for (const c of input.cells) {
        if (bytes(c.chartSettings) > PAYLOAD_LIMIT_BYTES) return fail(413, "payload_too_large", "차트 설정이 64KB를 넘습니다");
        if (c.symbol.startsWith("IDX:") !== (c.venue === null)) return fail(400, "bad_request", "지수에는 거래소가 없고, 주식에는 있어야 합니다");
      }
      const stored = layouts.get(id);
      if (stored && input.revision <= stored.revision) return stale(stored.revision);
      const saved: Layout = { ...input, updatedAt: nowSec() };
      layouts.set(id, saved);
      return ok(saved);
    },
    getUiState: (): Reply => ok(uiState),
    putUiState: (body: unknown): Reply => {
      if (!isObject(body)) return fail(400, "bad_request", "UiState는 객체여야 합니다");
      if (bytes(body) > PAYLOAD_LIMIT_BYTES) return fail(413, "payload_too_large", "UiState가 64KB를 넘습니다");
      if (!isRevision(body.revision)) return fail(400, "bad_request", "revision이 없습니다");
      if (body.revision <= (uiState.revision as number)) return stale(uiState.revision as number);
      uiState = body;
      return ok(uiState);
    },
    getWatchlists: (): Reply => ok(watchlists),
    putWatchlists: (body: unknown): Reply => {
      if (!isObject(body) || !Array.isArray(body.lists) || !body.lists.every(isWatchlist)) return fail(400, "bad_request", "관심종목 본문이 아닙니다");
      if (bytes(body) > PAYLOAD_LIMIT_BYTES) return fail(413, "payload_too_large", "관심종목이 64KB를 넘습니다");
      const lists = body.lists as Watchlist[];
      if (lists.length === 0 || lists.length > MAX_WATCHLISTS) return fail(400, "bad_request", "관심종목 목록은 1~20개여야 합니다");
      if (new Set(lists.map((l) => l.id)).size !== lists.length) return fail(400, "bad_request", "목록 id가 겹칩니다");
      if (new Set(lists.map((l) => l.name)).size !== lists.length) return fail(400, "bad_request", "같은 이름의 목록이 두 개 있습니다");
      for (const l of lists) {
        if (l.name.trim() !== l.name || l.name === "" || [...l.name].length > MAX_WATCHLIST_NAME) return fail(400, "bad_request", "목록 이름이 틀렸습니다");
        if (new Set(l.symbols).size !== l.symbols.length) return fail(400, "bad_request", "관심종목에 같은 종목이 두 번 있습니다");
      }
      if (!isRevision(body.revision)) return fail(400, "bad_request", "revision이 없습니다");
      if (body.revision <= watchlists.revision) return stale(watchlists.revision);
      watchlists = { lists, revision: body.revision };
      return ok(watchlists);
    },
  };
}
