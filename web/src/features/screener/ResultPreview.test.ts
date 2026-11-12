import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { BarsPage } from "../../api/generated/BarsPage";
import { resultBarsQuery } from "./ResultPreview";

afterEach(() => vi.unstubAllGlobals());

test("미리보기는 고른 종목의 KRX 일봉을 조회하고 종목별 자료를 분리한다", async () => {
  const page = (symbol: string): BarsPage => ({ symbol, venue: "krx", period: "D", bars: [{ t: 1, o: 10, h: 12, l: 9, c: 11, v: 20 }], current: null, nextBefore: null, seq: null });
  const fetch = vi.fn((url: string) => Promise.resolve(Response.json(page(new URL(url, "http://test").searchParams.get("symbol") ?? ""))));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const first = await client.fetchQuery(resultBarsQuery("005930"));
  const second = await client.fetchQuery(resultBarsQuery("000660"));
  expect(first.symbol).toBe("005930");
  expect(second.symbol).toBe("000660");
  expect(fetch.mock.calls.map(([url]) => new URL(url, "http://test").searchParams.get("venue"))).toEqual(["krx", "krx"]);
  expect(fetch.mock.calls.map(([url]) => new URL(url, "http://test").searchParams.get("period"))).toEqual(["D", "D"]);
  expect(fetch.mock.calls.map(([url]) => new URL(url, "http://test").searchParams.get("limit"))).toEqual(["60", "60"]);
  expect(client.getQueryData(resultBarsQuery("005930").queryKey)).toEqual(first);
});

test("일봉을 받지 못하면 자동 재요청하지 않고 다시 시도할 수 있다", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(Response.json({ symbol: "005930", venue: "krx", period: "D", bars: [], current: null, nextBefore: null, seq: null } satisfies BarsPage));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  await expect(client.fetchQuery(resultBarsQuery("005930"))).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await client.fetchQuery(resultBarsQuery("005930"))).bars).toEqual([]);
});
