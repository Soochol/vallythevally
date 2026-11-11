import type { Day, SourceResult } from "./bundle-types.ts";

export type HttpClient = (url: URL) => Promise<Response>;
export const httpClient: HttpClient = (url) => fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });

function isFields(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function fields(value: unknown): Record<string, unknown> {
  if (!isFields(value)) throw new Error("expected_object");
  return value;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected_array");
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected_string");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expected_finite_number");
  return value;
}
export function integer(value: unknown): number {
  const n = number(value);
  if (!Number.isSafeInteger(n)) throw new Error("expected_safe_integer");
  return n;
}
export function isDay(value: string): value is Day {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function day(value: unknown): Day {
  const s = text(value);
  if (!isDay(s)) throw new Error("invalid_date");
  return s;
}
export function compactDay(value: unknown): Day {
  const s = text(value);
  if (!/^\d{8}$/.test(s)) throw new Error("invalid_compact_date");
  return day(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`);
}
export function kstDay(seconds: number): Day {
  return day(new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 10));
}
export function weekStart(date: Day): Day {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return day(d.toISOString().slice(0, 10));
}
export function nextObservation(filedOn: Day, calendar: Day[]): Day | null {
  return calendar.find((d) => d > filedOn) ?? null;
}
export function endpoint(base: URL, path: string, params: Record<string, string> = {}): URL {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}
export async function getText(client: HttpClient, url: URL): Promise<string> {
  let response: Response;
  try { response = await client(url); } catch { throw new Error("request_failed"); }
  if (!response.ok) throw new Error(`http_${response.status}`);
  try { return await response.text(); } catch { throw new Error("response_read_failed"); }
}
export async function getJson(client: HttpClient, url: URL): Promise<unknown> {
  const body = await getText(client, url);
  try { return JSON.parse(body); } catch { throw new Error("invalid_json"); }
}
export async function capture<T>(source: string, run: () => Promise<T>): Promise<SourceResult<T>> {
  try { return { kind: "ok", source, data: await run() }; }
  catch (error) {
    const reason = error instanceof Error && /^[a-z_]+(?:[0-9]+)?$/.test(error.message) ? error.message : "source_format_failure";
    return { kind: "missing", source, reason };
  }
}
export function publicBase(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_base_url");
  return url;
}
