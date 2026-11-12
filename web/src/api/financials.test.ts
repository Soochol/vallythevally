import { environmentManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FinancialsPage } from "./generated/FinancialsPage";
import { financialsQuery } from "./financials";
import { commandFinancialUpdate } from "./financialUpdate";

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
  const first = commandFinancialUpdate(client, "start");
  await vi.waitFor(() => expect(posts).toBe(1));
  await commandFinancialUpdate(client, "start");
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

test("전체 갱신의 실패·재시도는 다른 종목·주기의 저장값을 보존하고 모두 무효화한다", async () => {
  let failure = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST" && failure) return new Response(JSON.stringify({ error: { code: "internal", message: "가짜 실패" } }), { status: 500 });
    return response({ ...page(), period: url.endsWith("Q") ? "Q" : "Y" });
  }));
  const q = { ...request, period: "Q" } as const;
  const other = { ...request, symbol: "000020" };
  const cachedQ = await client.fetchQuery(financialsQuery(q));
  const cachedOther = await client.fetchQuery(financialsQuery(other));
  await expect(commandFinancialUpdate(client, "start")).rejects.toThrow("가짜 실패");
  failure = false;
  await commandFinancialUpdate(client, "start");
  expect(client.getQueryData(financialsQuery(q).queryKey)).toBe(cachedQ);
  expect(client.getQueryData(financialsQuery(other).queryKey)).toBe(cachedOther);
  expect(client.getQueryState(financialsQuery(q).queryKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(financialsQuery(other).queryKey)?.isInvalidated).toBe(true);
});

test("세 POST의 3→1→2 완료와 중간 GET 지연에도 두 구독자의 최신 ready를 보존한다", async () => {
  const posts = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
  const reads = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
  let postCount=0, getCount=0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "POST" ? posts[postCount++]!.promise : ++getCount === 1 ? response(page()) : reads[getCount-2]!.promise));
  const one=new QueryObserver(client,financialsQuery(request)); const two=new QueryObserver(client,financialsQuery(request));
  const stop=[one.subscribe(()=>{}),two.subscribe(()=>{})];
  await vi.waitFor(()=>expect(getCount).toBe(1)); await vi.waitFor(()=>expect(one.getCurrentResult().data).toEqual(page()));
  const jobs=[commandFinancialUpdate(client, "start"),commandFinancialUpdate(client, "start"),commandFinancialUpdate(client, "start")];
  await vi.waitFor(()=>expect(postCount).toBe(3));
  for(const n of [2,0,1]) { posts[n]!.complete(response(page(n===0?"partial_failure":"collecting",n===0?1:3))); await vi.waitFor(()=>expect(getCount).toBe(n===2?2:n===0?3:4)); }
  reads[0]!.complete(response(page("partial_failure"))); reads[1]!.complete(response(page("collecting")));
  await new Promise(resolve=>setTimeout(resolve,20));
  for(const observer of [one,two]) expect(observer.getCurrentResult().data).toEqual(page());
  reads[2]!.complete(response(page())); await Promise.all(jobs);
  for(const observer of [one,two]) expect(observer.getCurrentResult().data).toEqual(page());
  stop.forEach(fn=>fn());
});


test.each([false, true].flatMap((failure) => (["start", "pause", "resume"] as const).map((action) => ({ failure, action }))))("$action 도중 활성화한 cold query는 완료·실패 뒤에도 새 GET으로 확인한다 (실패 $failure)", async ({ failure, action }) => {
  const post = deferred<Response>();
  const stale = deferred<Response>();
  let posts = 0;
  let gets = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") { posts++; return post.promise; }
    return ++gets === 1 ? stale.promise : response(page());
  }));
  const job = commandFinancialUpdate(client, action).then(() => null, (error: unknown) => error);
  await vi.waitFor(() => expect(posts).toBe(1));
  const one = new QueryObserver(client, financialsQuery(request));
  const two = new QueryObserver(client, financialsQuery(request));
  const stop = [one.subscribe(() => {}), two.subscribe(() => {})];
  await vi.waitFor(() => expect(gets).toBe(1));
  expect(one.getCurrentResult().data).toBeUndefined();
  expect(two.getCurrentResult().data).toBeUndefined();
  post.complete(failure ? new Response(JSON.stringify({ error: { code: "internal", message: "가짜 실패" } }), { status: 500 }) : response(page("collecting", 1)));
  await vi.waitFor(() => expect(gets).toBe(2));
  stale.complete(response(page("partial_failure", 1)));
  const error = await job;
  if (failure) expect(error).toBeInstanceOf(Error);
  else expect(error).toBeNull();
  for (const observer of [one, two]) expect(observer.getCurrentResult().data).toEqual(page());
  stop.forEach((unsubscribe) => unsubscribe());
});
