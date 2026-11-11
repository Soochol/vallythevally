import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../api/generated/Screen";
import type { ScreenerResult } from "../api/generated/ScreenerResult";
import type { ScreenerStatus } from "../api/generated/ScreenerStatus";
import { rerunReason, useScreenerStore } from "./screener";

const screen: Screen = { id: "s1", name: "고가 1,000일 신고가", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", m: 20, field: "high", n: 1000 }] };
const result: ScreenerResult = { asOf: "2026-11-10", universe: 28, excluded: { listedTooShort: 0, historyShort: 28, unconfirmed: 0 }, rows: [] };
const store = (done: number, update: ScreenerStatus["update"] = null, lastDay = "2026-11-10"): ScreenerStatus => ({
  lastDay,
  needDay: "2026-11-10",
  todayAvailable: false,
  fullHistory: { done, total: 28 },
  unconfirmed: 0,
  update,
});
const backfilling = (full = false): ScreenerStatus["update"] => ({ phase: "backfill", done: 3, total: 28, error: null, full });
const recentFull: ScreenerStatus["update"] = { phase: "recent", done: 0, total: 28, error: null, full: true };

beforeEach(() => {
  useScreenerStore.setState({ chosenId: null, runs: {}, storeVersion: 0, seen: null });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(result), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

const see = (status: ScreenerStatus) => useScreenerStore.getState().seeStatus(status);
const reasonAt = (status: ScreenerStatus) => {
  const s = useScreenerStore.getState();
  return rerunReason(s.runs[screen.id] ?? null, s.storeVersion, status);
};

test("같은 관측일에 과거 이력이 더 들어오면 다시 실행을 권한다", async () => {
  see(store(0));
  await useScreenerStore.getState().run(screen);
  see(store(0));
  expect(reasonAt(store(0))).toBeNull();

  see(store(12, backfilling()));
  expect(reasonAt(store(12, backfilling()))).toEqual({ kind: "store_changed" });
  see(store(28));
  expect(reasonAt(store(28))).toEqual({ kind: "store_changed" });
});

test("전체 다시 받기가 끝나면 이력 수가 같아도 다시 실행을 권하고, 업데이트가 시작만 해서는 권하지 않는다", async () => {
  see(store(28));
  await useScreenerStore.getState().run(screen);
  see(store(28, recentFull));
  expect(reasonAt(store(28, recentFull))).toBeNull();
  see(store(28));
  expect(reasonAt(store(28))).toEqual({ kind: "store_changed" });
});

test("새 관측일이 들어오면 그 날을 알린다", async () => {
  see(store(28));
  await useScreenerStore.getState().run(screen);
  const next = store(28, null, "2026-11-11");
  see(next);
  expect(reasonAt(next)).toEqual({ kind: "new_day", day: "2026-11-11" });
});

test("실행 뒤 처음 받은 상태는 바뀐 것으로 치지 않고, 다시 실행하면 안내가 사라진다", async () => {
  await useScreenerStore.getState().run(screen);
  see(store(12, backfilling()));
  expect(reasonAt(store(12, backfilling()))).toBeNull();
  see(store(13, backfilling()));
  expect(reasonAt(store(13, backfilling()))).toEqual({ kind: "store_changed" });
  await useScreenerStore.getState().run(screen);
  expect(reasonAt(store(13, backfilling()))).toBeNull();
});
