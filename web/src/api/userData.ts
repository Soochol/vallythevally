import type { Layout } from "./generated/Layout";
import type { LayoutSummary } from "./generated/LayoutSummary";
import type { Quote } from "./generated/Quote";
import type { SymbolCode } from "./generated/SymbolCode";
import type { Watchlists } from "./generated/Watchlists";
import { getJson } from "./http";

export const QUOTES_MAX_SYMBOLS = 200;

export const layoutPath = (id: string) => `/api/layouts/${encodeURIComponent(id)}`;
export const UI_STATE_PATH = "/api/ui-state";
export const WATCHLISTS_PATH = "/api/watchlists";

export const fetchLayouts = (signal?: AbortSignal) => getJson<LayoutSummary[]>("/api/layouts", signal);
export const fetchLayout = (id: string, signal?: AbortSignal) => getJson<Layout>(layoutPath(id), signal);
export const fetchUiState = (signal?: AbortSignal) => getJson<unknown>(UI_STATE_PATH, signal);
export const fetchWatchlists = (signal?: AbortSignal) => getJson<Watchlists>(WATCHLISTS_PATH, signal);

export async function fetchQuotes(symbols: readonly SymbolCode[], signal?: AbortSignal): Promise<Quote[]> {
  const chunks: SymbolCode[][] = [];
  for (let i = 0; i < symbols.length; i += QUOTES_MAX_SYMBOLS) chunks.push(symbols.slice(i, i + QUOTES_MAX_SYMBOLS));
  const pages = await Promise.all(
    chunks.map((c) => getJson<Quote[]>(`/api/quotes?symbols=${c.map(encodeURIComponent).join(",")}`, signal)),
  );
  return pages.flat();
}
