import { environmentManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FinancialsPage } from "./generated/FinancialsPage";
import { financialsQuery } from "./financials";

const page = (status: string): FinancialsPage => ({ symbol: "005930", period: "Y", status, refreshVersion: 3, disclosureVersion: 3, reason: null, failure: null, corpCode: "00126380", fiscalMonth: 12, shareClass: null, shareClassReason: null, lastCheckedAt: 100, lastAttemptAt: 100, disclosureFailure: null, latestCorrections: true, progress: { total: 10, completed: 10, failed: 0, pending: 0 }, series: [] });
const request = { symbol: "005930", period: "Y" } as const;
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  environmentManager.setIsServer(() => false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  client.mount();
});
afterEach(() => {
  client.unmount(); client.clear(); vi.unstubAllGlobals(); vi.useRealTimers();
  environmentManager.setIsServer(() => typeof window === "undefined");
});

test.each(["ready", "stale", "partial_failure", "not_collected"])("%s 조회는 한 번만 요청하고 시간이 지나도 다시 요청하지 않는다", async (status) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(page(status)), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const observer = new QueryObserver(client, financialsQuery(request));
  const stop = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe(status));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/symbols/005930/financials?period=Y", expect.anything());
  stop();
});

test("종목과 주기마다 따로 조회한다", async () => {
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ ...page("ready"), period: url.endsWith("Q") ? "Q" : "Y" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await client.fetchQuery(financialsQuery(request));
  await client.fetchQuery(financialsQuery({ ...request, period: "Q" }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
