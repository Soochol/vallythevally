import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { DEFAULT_WATCHLISTS, FIRST_WATCHLIST_ID } from "../../lib/watchlist";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";
import { dropPendingOpen, openResult, pendingResultCode, sendToNewWatchlist, sendToWatchlist } from "./resultActions";

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const symbol = (code: string): SymbolInfo => ({ code, name: code, market: "kospi", kind: "common", nxtEnabled: true });
const CELL = chartWindows(DEFAULT_LAYOUT)[0]!.id;
const cell = () => chartWindows(useLayoutStore.getState().layout)[0]!;

beforeEach(() => {
  dropPendingOpen();
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useLayoutStore.getState().setSymbol(CELL, { code: "005930", nxtEnabled: true }, "nxt");
  useLayoutStore.getState().setPeriod(CELL, "W");
  useSelectionStore.setState({ activeCell: CELL, phoneTab: "screener", toast: null });
  useWatchlistStore.getState().load(DEFAULT_WATCHLISTS);
});
afterEach(() => vi.unstubAllGlobals());

test("결과 열기는 현재 칸의 거래소와 주기를 유지하고 휴대폰 차트로 돌아간다", async () => {
  const query = client();
  query.setQueryData(["symbol", "000660"], symbol("000660"));
  await openResult(query, "000660");
  expect(cell()).toMatchObject({ symbol: "000660", venue: "nxt", period: "W" });
  expect(useSelectionStore.getState().phoneTab).toBe("chart");
});

test("종목 정보가 실패해도 통합으로 결과를 열 수 있다", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  await openResult(client(), "000660");
  expect(cell()).toMatchObject({ symbol: "000660", venue: "combined", period: "W" });
});

test("빠른 다음 열기는 늦은 이전 응답보다 우선한다", async () => {
  let resolveFirst: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFirst = resolve; })));
  const query = client();
  const first = openResult(query, "000660");
  expect(pendingResultCode()).toBe("000660");
  query.setQueryData(["symbol", "035420"], symbol("035420"));
  await openResult(query, "035420");
  resolveFirst(Response.json(symbol("000660")));
  await first;
  expect(cell().symbol).toBe("035420");
});

test.each(["chart", "tab", "unmount"])("정보 대기 중 다른 선택은 늦은 응답으로 덮지 않는다 %s", async (change) => {
  let resolve: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  const opened = openResult(client(), "000660");
  if (change === "chart") useLayoutStore.getState().setSymbol(CELL, { code: "035420", nxtEnabled: true });
  else if (change === "tab") useSelectionStore.getState().setPhoneTab("watch");
  else dropPendingOpen();
  resolve(Response.json(symbol("000660")));
  await opened;
  expect(cell().symbol).toBe(change === "chart" ? "035420" : "005930");
  expect(useSelectionStore.getState().phoneTab).toBe(change === "tab" ? "watch" : "screener");
});

test("관심종목 저장은 기존 목록의 중복을 건너뛰고 결과 순서를 유지한다", () => {
  useWatchlistStore.getState().add(FIRST_WATCHLIST_ID, "005930");
  const before = useWatchlistStore.getState().revision;
  sendToWatchlist(FIRST_WATCHLIST_ID, ["000660", "005930", "035420"]);
  expect(useWatchlistStore.getState().lists[0]?.symbols).toEqual(["005930", "000660", "035420"]);
  expect(useWatchlistStore.getState().revision).toBe(before + 1);
  expect(useSelectionStore.getState().toast?.text).toContain("이미 있던 1종목은 건너뜀");
  sendToNewWatchlist("실행 결과", ["035420", "000660"]);
  const list = useWatchlistStore.getState().lists[1];
  expect(list).toMatchObject({ name: "실행 결과", symbols: ["035420", "000660"] });
  expect(useUiStore.getState().prefs.activeWatchlistId).toBe(list?.id);
});
