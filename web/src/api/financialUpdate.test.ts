import { environmentManager, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FinancialsPage } from "./generated/FinancialsPage";
import type { FinancialUpdatePage } from "./generated/FinancialUpdatePage";
import { financialsQuery } from "./financials";
import { financialUpdateQuery, watchFinancialJob } from "./financialUpdate";

const job = (overrides: Partial<FinancialUpdatePage> = {}): FinancialUpdatePage => ({
  id: 1, status: "collecting", phase: "recent", stopReason: null, nextCheckAt: null, canResume: false, automatic: true, latestCheckPending: false,
  historyCompletedCompanies: 0, historyFailedCompanies: 0, recentFailedCompanies: 0, historyComplete: false, fromYear: 2023, throughYear: 2025,
  totalSymbols: 20, processedSymbols: 20, unsupportedSymbols: 0, unverifiedSymbols: 0, unverifiedDividends: 0, totalCompanies: 10, completedCompanies: 2,
  failedCompanies: 0, startedAt: 100, lastCheckedAt: 100, failure: null, failures: [], ...overrides,
});
const page = (symbol = "005930", period: "Y" | "Q" = "Y"): FinancialsPage => ({ symbol, period, status: "ready", refreshVersion: 3, disclosureVersion: 3, reason: null, failure: null, corpCode: "00126380", fiscalMonth: 12, shareClass: null, shareClassReason: null, lastCheckedAt: 100, lastAttemptAt: 100, disclosureFailure: null, latestCorrections: true, progress: { total: 10, completed: 10, failed: 0, pending: 0 }, series: [] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const requests = [{ symbol: "005930", period: "Y" }, { symbol: "005930", period: "Q" }, { symbol: "000020", period: "Y" }] as const;

let client: QueryClient;
let jobBody: () => Response;
let unwatch: () => void;

const invalidated = () => requests.map((request) => client.getQueryState(financialsQuery(request).queryKey)?.isInvalidated);
const freshFinancials = async () => {
  for (const request of requests) await client.fetchQuery(financialsQuery(request));
  expect(invalidated()).toEqual([false, false, false]);
};
const respond = (body: FinancialUpdatePage) => { jobBody = () => json(body); };
const fetchJob = () => client.fetchQuery(financialUpdateQuery);

beforeEach(() => {
  environmentManager.setIsServer(() => false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  client.mount();
  respond(job());
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/financial-update") return jobBody();
    const symbol = decodeURIComponent(url.split("/")[3]!);
    return json(page(symbol, url.endsWith("Q") ? "Q" : "Y"));
  }));
  unwatch = watchFinancialJob(client);
});
afterEach(() => {
  unwatch();
  client.unmount(); client.clear(); vi.unstubAllGlobals();
  environmentManager.setIsServer(() => typeof window === "undefined");
});

test("첫 성공 응답은 여러 종목·주기의 재무지표를 모두 무효화한다", async () => {
  await freshFinancials();
  await fetchJob();
  await vi.waitFor(() => expect(invalidated()).toEqual([true, true, true]));
});

test("내용이 바뀐 응답은 재무지표를 무효화한다", async () => {
  await fetchJob();
  await settle();
  await freshFinancials();
  respond(job({ completedCompanies: 3 }));
  await fetchJob();
  await vi.waitFor(() => expect(invalidated()).toEqual([true, true, true]));
});

test("내용이 같은 새 응답은 참조가 같아 무효화하지 않는다", async () => {
  await fetchJob();
  const first = client.getQueryData(financialUpdateQuery.queryKey);
  await settle();
  await freshFinancials();
  respond(job());
  await fetchJob();
  expect(client.getQueryData(financialUpdateQuery.queryKey)).toBe(first);
  await settle();
  expect(invalidated()).toEqual([false, false, false]);
});

test.each<[string, Partial<FinancialUpdatePage>]>([
  ["unverifiedDividends", { unverifiedDividends: 1 }],
  ["lastCheckedAt", { lastCheckedAt: 200 }],
])("%s 하나만 바뀐 응답도 무효화한다", async (_, change) => {
  await fetchJob();
  await settle();
  await freshFinancials();
  respond(job(change));
  await fetchJob();
  await vi.waitFor(() => expect(invalidated()).toEqual([true, true, true]));
});

test("실패한 응답은 무효화하지 않는다", async () => {
  await fetchJob();
  await settle();
  await freshFinancials();
  jobBody = () => json({ error: { code: "internal", message: "가짜 실패" } }, 500);
  await expect(fetchJob()).rejects.toThrow("가짜 실패");
  await settle();
  expect(invalidated()).toEqual([false, false, false]);
});

test("구독을 해제하면 바뀐 응답에도 무효화하지 않는다", async () => {
  await fetchJob();
  await settle();
  await freshFinancials();
  unwatch();
  respond(job({ completedCompanies: 9 }));
  await fetchJob();
  await settle();
  expect(invalidated()).toEqual([false, false, false]);
});

test("재무지표 자신의 갱신은 무효화를 부르지 않는다", async () => {
  await fetchJob();
  await settle();
  await freshFinancials();
  await settle();
  expect(invalidated()).toEqual([false, false, false]);
  for (const request of requests) await client.fetchQuery({ ...financialsQuery(request), staleTime: 0 });
  await settle();
  expect(invalidated()).toEqual([false, false, false]);
});

test("성공 응답이 아닌 상태 변화는 데이터가 사라져도 무효화하지 않는다", async () => {
  await fetchJob();
  await settle();
  await freshFinancials();
  await client.resetQueries({ queryKey: financialUpdateQuery.queryKey });
  await settle();
  expect(client.getQueryData(financialUpdateQuery.queryKey)).toBeUndefined();
  expect(invalidated()).toEqual([false, false, false]);
});
