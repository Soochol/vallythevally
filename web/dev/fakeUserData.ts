import type { ApiErrorCode } from "../src/api/generated/ApiErrorCode.ts";
import type { BarField } from "../src/api/generated/BarField.ts";
import type { Condition } from "../src/api/generated/Condition.ts";
import type { ExcludeKind } from "../src/api/generated/ExcludeKind.ts";
import type { Layout } from "../src/api/generated/Layout.ts";
import type { LayoutInput } from "../src/api/generated/LayoutInput.ts";
import type { LayoutSummary } from "../src/api/generated/LayoutSummary.ts";
import type { Screen } from "../src/api/generated/Screen.ts";
import type { Screens } from "../src/api/generated/Screens.ts";
import type { ScreenPeriod } from "../src/api/generated/ScreenPeriod.ts";
import type { Watchlist } from "../src/api/generated/Watchlist.ts";
import type { Watchlists } from "../src/api/generated/Watchlists.ts";

export const PAYLOAD_LIMIT_BYTES = 64 * 1024;
const SCREENS_LIMIT_BYTES = 2 * PAYLOAD_LIMIT_BYTES;
export const DEFAULT_LAYOUT_ID = "01900000-0000-7000-8000-000000000001";
export const FIRST_WATCHLIST_ID = "01900000-0000-7000-8000-000000000002";
const MAX_WATCHLISTS = 20;
const MAX_WATCHLIST_NAME = 20;
const MAX_SCREENS = 50;
const MAX_SCREEN_NAME = 40;
const MAX_SCREEN_CONDITIONS = 10;
const MAX_SCREEN_ID_BYTES = 64;
const MAX_U32 = 4_294_967_295;
const BAR_FIELDS: readonly string[] = ["open", "high", "low", "close", "volume", "traded_value"] satisfies BarField[];
const MARKETS: readonly string[] = ["kospi", "kosdaq"];
const EXCLUDE_KINDS: readonly string[] = [
  "etf",
  "preferred",
  "reit",
  "spac",
  "managed",
  "investment_caution_alert",
  "investment_warning",
  "investment_danger",
  "investment_caution",
  "short_term_overheated",
  "trading_halted",
] satisfies ExcludeKind[];
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
const isU32 = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_U32;
const CONDITION_KINDS: readonly string[] = [
  "new_high",
  "new_low",
  "value_range",
  "change",
  "near_extreme",
  "surge",
  "ma_position",
  "ma_alignment",
  "ma_cross",
  "rsi",
  "macd",
  "stochastic",
  "bollinger",
  "ichimoku",
  "market_cap",
] satisfies Condition["kind"][];
const SCREEN_PERIODS: readonly string[] = ["D", "W", "M"] satisfies ScreenPeriod[];
const isRecordKind = (kind: unknown) => kind === "new_high" || kind === "new_low";
const isCondition = (x: unknown): x is Condition =>
  isObject(x) &&
  typeof x.kind === "string" &&
  CONDITION_KINDS.includes(x.kind) &&
  (x.kind === "market_cap" || (typeof x.period === "string" && SCREEN_PERIODS.includes(x.period) && isU32(x.m))) &&
  (!isRecordKind(x.kind) || (typeof x.field === "string" && BAR_FIELDS.includes(x.field) && isU32(x.n)));
export const isScreen = (x: unknown): x is Screen =>
  isObject(x) &&
  typeof x.id === "string" &&
  typeof x.name === "string" &&
  Array.isArray(x.markets) &&
  x.markets.every((m) => typeof m === "string" && MARKETS.includes(m)) &&
  Array.isArray(x.exclude) &&
  x.exclude.every((k) => typeof k === "string" && EXCLUDE_KINDS.includes(k)) &&
  Array.isArray(x.conditions) &&
  x.conditions.every(isCondition);

function screensProblem(screens: readonly Screen[]): string | null {
  if (screens.length > MAX_SCREENS) return `조건식은 ${MAX_SCREENS}개까지 저장할 수 있습니다: ${screens.length}개`;
  const ids = new Set<string>();
  for (const s of screens) {
    const idBytes = new TextEncoder().encode(s.id).length;
    if (idBytes === 0 || idBytes > MAX_SCREEN_ID_BYTES || ids.has(s.id)) return `조건식 id가 비었거나 길거나 겹칩니다: ${s.id}`;
    ids.add(s.id);
    const nameChars = [...s.name.trim()].length;
    if (nameChars < 1 || nameChars > MAX_SCREEN_NAME) return `조건식 이름은 공백을 빼고 1~${MAX_SCREEN_NAME}자여야 합니다: ${JSON.stringify(s.name)}`;
    if (s.conditions.length > MAX_SCREEN_CONDITIONS) return `조건식 ${s.name}의 조건은 0~${MAX_SCREEN_CONDITIONS}줄이어야 합니다: ${s.conditions.length}줄`;
    for (const c of s.conditions) {
      if (c.kind === "market_cap") continue;
      if (c.m < 1) return `조건식 ${s.name}의 조건은 m ≥ 1이어야 합니다: m=${c.m}`;
      if ((c.kind === "new_high" || c.kind === "new_low") && c.m > c.n) return `조건식 ${s.name}의 조건은 m ≤ n이어야 합니다: n=${c.n}, m=${c.m}`;
    }
    if (new Set(s.markets).size !== s.markets.length) return `조건식 ${s.name}의 시장 목록에 같은 것이 두 번 있습니다`;
    if (new Set(s.exclude).size !== s.exclude.length) return `조건식 ${s.name}의 제외 목록에 같은 것이 두 번 있습니다`;
  }
  return null;
}

export function createUserData(seedWatchlist: string[], seedScreens: Screen[], nowSec: () => number = () => Math.floor(Date.now() / 1000)) {
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
  let screens: Screens = { screens: seedScreens, revision: 0 };

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
    getScreens: (): Reply => ok(screens),
    putScreens: (body: unknown): Reply => {
      if (bytes(body) > SCREENS_LIMIT_BYTES) return fail(413, "payload_too_large", "조건식 본문이 128KB를 넘습니다");
      if (!isObject(body) || !Array.isArray(body.screens) || !body.screens.every(isScreen)) return fail(400, "bad_request", "조건식 본문의 JSON이 틀렸습니다");
      if (!isRevision(body.revision)) return fail(400, "bad_request", "revision이 없습니다");
      const problem = screensProblem(body.screens);
      if (problem) return fail(400, "bad_request", problem);
      if (body.revision <= screens.revision) return stale(screens.revision);
      screens = { screens: body.screens, revision: body.revision };
      return ok(screens);
    },
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
