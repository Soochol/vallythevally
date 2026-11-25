import { getJson } from "./http";
import type { MicroEventsPage } from "./generated/MicroEventsPage";
import type { SymbolCode } from "./generated/SymbolCode";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function kstYyyymmdd(epochMs: number): string {
  const d = new Date(epochMs + KST_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function fetchMicroEvents(symbol: SymbolCode, date?: string, signal?: AbortSignal): Promise<MicroEventsPage> {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return getJson<MicroEventsPage>(`/api/symbols/${encodeURIComponent(symbol)}/micro-events${query}`, signal);
}
