// 사용자 자료 API(backend.md §8.2, #3). 받은 값의 모양 검사는 persist/가 한다.
import type { Layout } from "./generated/Layout";
import type { LayoutSummary } from "./generated/LayoutSummary";
import type { Quote } from "./generated/Quote";
import type { SymbolCode } from "./generated/SymbolCode";
import type { Watchlist } from "./generated/Watchlist";
import { getJson } from "./http";

/** `GET /api/quotes`가 한 번에 받는 종목 수. */
export const QUOTES_MAX_SYMBOLS = 200;

export const layoutPath = (id: string) => `/api/layouts/${encodeURIComponent(id)}`;
export const UI_STATE_PATH = "/api/ui-state";
export const WATCHLIST_PATH = "/api/watchlist";

export const fetchLayouts = (signal?: AbortSignal) => getJson<LayoutSummary[]>("/api/layouts", signal);
export const fetchLayout = (id: string, signal?: AbortSignal) => getJson<Layout>(layoutPath(id), signal);
/** 모르는 키가 섞여 있으므로 unknown으로 받아 persist/uiState.ts에서 해석한다. */
export const fetchUiState = (signal?: AbortSignal) => getJson<unknown>(UI_STATE_PATH, signal);
export const fetchWatchlist = (signal?: AbortSignal) => getJson<Watchlist>(WATCHLIST_PATH, signal);

/** 값을 얻지 못한 종목은 빠진다. 200개씩 나눠 묻고 요청 순서대로 잇는다. */
export async function fetchQuotes(symbols: readonly SymbolCode[], signal?: AbortSignal): Promise<Quote[]> {
  const chunks: SymbolCode[][] = [];
  for (let i = 0; i < symbols.length; i += QUOTES_MAX_SYMBOLS) chunks.push(symbols.slice(i, i + QUOTES_MAX_SYMBOLS));
  const pages = await Promise.all(
    chunks.map((c) => getJson<Quote[]>(`/api/quotes?symbols=${c.map(encodeURIComponent).join(",")}`, signal)),
  );
  return pages.flat();
}
