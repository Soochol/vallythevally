import type { QuoteDepthPage } from "./generated/QuoteDepthPage";
import type { QuoteTotalsPage } from "./generated/QuoteTotalsPage";
import type { QuoteKey, QuoteRange } from "../chart/quotes/feed";
import { getJson } from "./http";

export function quoteTotalsUrl(key: QuoteKey, range: QuoteRange): string {
  const params = new URLSearchParams({ period: key.period, venue: key.venue, from: range.from, to: range.to });
  if (range.after !== undefined) params.set("after", String(range.after));
  return `/api/symbols/${encodeURIComponent(key.symbol)}/quote-totals?${params}`;
}

export function fetchQuoteTotals(key: QuoteKey, range: QuoteRange, signal?: AbortSignal): Promise<QuoteTotalsPage> {
  return getJson<QuoteTotalsPage>(quoteTotalsUrl(key, range), signal);
}

export function quoteDepthUrl(key: QuoteKey, range: QuoteRange): string {
  const params = new URLSearchParams({ period: key.period, venue: key.venue, source: key.variant ?? "priceMax", from: range.from, to: range.to });
  if (range.after !== undefined) params.set("after", String(range.after));
  return `/api/symbols/${encodeURIComponent(key.symbol)}/quote-depth?${params}`;
}

export function fetchQuoteDepth(key: QuoteKey, range: QuoteRange, signal?: AbortSignal): Promise<QuoteDepthPage> {
  return getJson<QuoteDepthPage>(quoteDepthUrl(key, range), signal);
}
