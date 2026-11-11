import { environmentManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FinancialsPage } from "./generated/FinancialsPage";
import { financialsQuery, refreshFinancials } from "./financials";

function deferred<T>() {
  let complete: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, complete };
}
const page = (status = "ready", version = 3): FinancialsPage => ({ symbol: "005930", period: "Y", status, refreshVersion: version, disclosureVersion: version, reason: null, failure: null, corpCode: "00126380", fiscalMonth: 12, shareClass: null, shareClassReason: null, lastCheckedAt: 100, lastAttemptAt: 100, disclosureFailure: null, latestCorrections: true, progress: { total: 10, completed: status === "ready" ? 10 : 2, failed: status === "partial_failure" ? 1 : 0, pending: status === "ready" ? 0 : status === "partial_failure" ? 7 : 8 }, series: [] });
const response = (body: FinancialsPage) => new Response(JSON.stringify(body), { status: 200 });
const request = { symbol: "005930", period: "Y" } as const;
let client: QueryClient;

beforeEach(() => {
  environmentManager.setIsServer(() => false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  client.mount();
});
afterEach(() => {
  client.unmount(); client.clear(); vi.unstubAllGlobals();
  environmentManager.setIsServer(() => typeof window === "undefined");
});

test.each(["collecting", "partial_failure"])("공유 키에서 늦은 GET과 중첩 POST의 %s가 같은 세대의 ready를 덮지 않는다", async (status) => {
  const oldGet = deferred<Response>();
  const oldPost = deferred<Response>();
  const freshGet = deferred<Response>();
  let gets = 0;
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") return ++posts === 1 ? oldPost.promise : response(page(status));
    const n = ++gets;
    if (n === 2) return oldGet.promise;
    if (n === 4) return freshGet.promise;
    return response(page());
  }));
  const one = new QueryObserver(client, financialsQuery(request));
  const two = new QueryObserver(client, financialsQuery(request));
  const stop = [one.subscribe(() => {}), two.subscribe(() => {})];
  await vi.waitFor(() => expect(one.getCurrentResult().data?.status).toBe("ready"));
  void client.refetchQueries({ queryKey: financialsQuery(request).queryKey });
  await vi.waitFor(() => expect(gets).toBe(2));
  const first = refreshFinancials(client, request);
  await vi.waitFor(() => expect(posts).toBe(1));
  await refreshFinancials(client, request);
  expect(gets).toBe(3);
  oldGet.complete(response(page(status)));
  oldPost.complete(response(page(status, 1)));
  await vi.waitFor(() => expect(gets).toBe(4));
  for (const observer of [one, two]) expect(observer.getCurrentResult().data).toEqual(page());
  freshGet.complete(response(page()));
  await first;
  for (const observer of [one, two]) expect(observer.getCurrentResult().data).toEqual(page());
  stop.forEach((unsubscribe) => unsubscribe());
});

test("다른 종목·주기 키는 수동 갱신의 취소·실패·재시도와 독립이다", async () => {
  let failure = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST" && failure) return new Response(JSON.stringify({ error: { code: "internal", message: "가짜 실패" } }), { status: 500 });
    return response({ ...page(), period: url.endsWith("Q") ? "Q" : "Y" });
  }));
  const q = { ...request, period: "Q" } as const;
  const other = { ...request, symbol: "000020" };
  const cachedQ = await client.fetchQuery(financialsQuery(q));
  const cachedOther = await client.fetchQuery(financialsQuery(other));
  await expect(refreshFinancials(client, request)).rejects.toThrow("가짜 실패");
  failure = false;
  await refreshFinancials(client, request);
  expect(client.getQueryData(financialsQuery(q).queryKey)).toBe(cachedQ);
  expect(client.getQueryData(financialsQuery(other).queryKey)).toBe(cachedOther);
});
