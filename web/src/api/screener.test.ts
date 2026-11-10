import { environmentManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

const watchStatus = () => {
  const observer = new QueryObserver(client, screenerStatusQuery(1_000));
  return observer.subscribe(() => {});
};
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
