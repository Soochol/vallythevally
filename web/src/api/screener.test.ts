import { environmentManager, focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { statusFooter } from "../lib/screener";
import type { ScreenerStatus } from "./generated/ScreenerStatus";
import { screenerCommands, screenerStatusQuery } from "./screener";

const idle: ScreenerStatus = { lastDay: "2026-11-10", needDay: "2026-11-10", todayAvailable: false, fullHistory: { done: 28, total: 28 }, update: null };
const running: ScreenerStatus = { ...idle, update: { phase: "recent", done: 0, total: 28, error: null, full: false } };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

let client: QueryClient;
let statusReads: number;
let answerStatus: () => Promise<Response>;

beforeEach(() => {
  environmentManager.setIsServer(() => false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  client.mount();
  statusReads = 0;
  answerStatus = async () => reply(idle);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") return reply(running);
      statusReads++;
      return answerStatus();
    }),
  );
});

afterEach(() => {
  client.unmount();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  environmentManager.setIsServer(() => typeof window === "undefined");
});

const statusObserver = () => new QueryObserver(client, screenerStatusQuery(1_000));
const watchStatus = () => statusObserver().subscribe(() => {});
const cached = () => client.getQueryData<ScreenerStatus>(screenerStatusQuery(1_000).queryKey);

test("업데이트 명령보다 먼저 떠난 상태 조회가 늦게 와도 명령이 돌려준 진행 상태를 덮지 않고, 명령 뒤에 다시 묻는다", async () => {
  const stop = watchStatus();
  await vi.waitFor(() => expect(cached()).toEqual(idle));

  let answerLate!: () => void;
  answerStatus = () => new Promise((resolve) => (answerLate = () => resolve(reply(idle))));
  void client.refetchQueries({ queryKey: screenerStatusQuery(1_000).queryKey });
  await vi.waitFor(() => expect(statusReads).toBe(2));

  answerStatus = async () => reply(running);
  await screenerCommands(client).start(false);
  answerLate();
  await vi.waitFor(() => expect(statusReads).toBe(3));
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(cached()?.update?.phase).toBe("recent");
  stop();
});

test("업데이트가 없으면 KST 20:00과 자정 바로 뒤에만 상태를 다시 묻는다", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-11T19:58:00+09:00"), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const stop = watchStatus();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusReads).toBe(1);

  await vi.advanceTimersByTimeAsync(2 * 60_000);
  expect(statusReads).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(statusReads).toBe(2);

  await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 59 * 60_000);
  expect(statusReads).toBe(2);
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  expect(statusReads).toBe(3);
  stop();
});

test("탭이 다시 보이면 상태를 다시 묻는다", async () => {
  const stop = watchStatus();
  await vi.waitFor(() => expect(cached()).toEqual(idle));
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await vi.waitFor(() => expect(statusReads).toBe(2));
  focusManager.setFocused(undefined);
  stop();
});

test("상태를 한 번 읽은 뒤 탭 복귀 조회가 실패하면 아래 줄이 오류와 다시 시도를 보이고, 다시 읽으면 저장소 줄로 돌아간다", async () => {
  const observer = statusObserver();
  const stop = observer.subscribe(() => {});
  await vi.waitFor(() => expect(cached()).toEqual(idle));
  const footer = () => {
    const shown = observer.getCurrentResult();
    return statusFooter(shown.data, shown.error);
  };
  expect(footer()).toEqual({ kind: "store", lastDay: "2026-11-10" });

  answerStatus = async () => new Response(JSON.stringify({ error: { code: "internal", message: "저장소를 열지 못했습니다" } }), { status: 500 });
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await vi.waitFor(() => expect(footer()).toEqual({ kind: "unreadable", message: "저장소를 열지 못했습니다", stale: true }));

  answerStatus = async () => reply(idle);
  await observer.refetch();
  expect(footer()).toEqual({ kind: "store", lastDay: "2026-11-10" });
  focusManager.setFocused(undefined);
  stop();
});
