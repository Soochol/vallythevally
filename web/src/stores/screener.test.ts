import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../api/generated/Screen";
import type { ScreenerResult } from "../api/generated/ScreenerResult";
import type { ScreenerStatus } from "../api/generated/ScreenerStatus";
import { rerunReason, runOf, shownResult, useScreenerStore } from "./screener";

const screen: Screen = { id: "s1", name: "고가 1,000일 신고가", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", recentBars: 20, field: "high", n: 1000 }] };
const result: ScreenerResult = { asOf: "2026-11-10", collectionStartedAt: 1, collectionCompletedAt: 2, missingSummary: 0, universe: 28, excluded: { listedTooShort: 0, historyShort: 28, unconfirmed: 0 }, rows: [] };
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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

const responseOf = (value: ScreenerResult) => new Response(JSON.stringify(value), { status: 200 });
const failedResponse = () => new Response(JSON.stringify({ error: { code: "screener_not_ready", reason: "data_changed", message: "자료 변경" } }), { status: 409 });
const currentRun = () => useScreenerStore.getState().runs[screen.id] ?? null;

test("실행 중과 반복 실패 뒤에도 이전 결과와 원래 수집 시각 및 저장소 변경 안내를 보존한다", async () => {
  see(store(28));
  await useScreenerStore.getState().run(screen);
  const gate = deferredResponse();
  vi.stubGlobal("fetch", vi.fn(() => gate.promise));
  const pending = useScreenerStore.getState().run(screen);
  expect(shownResult(currentRun())).toEqual(result);
  see(store(28, recentFull));
  see(store(28));
  gate.resolve(failedResponse());
  await pending;
  expect(currentRun()?.kind).toBe("failed");
  expect(shownResult(currentRun())).toEqual(result);
  expect(reasonAt(store(28))).toEqual({ kind: "store_changed" });
  await useScreenerStore.getState().run(screen);
  expect(shownResult(currentRun())).toEqual(result);
});

test("처음 실패하면 이전 결과를 만들지 않는다", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => failedResponse()));
  await useScreenerStore.getState().run(screen);
  expect(currentRun()?.kind).toBe("failed");
  expect(shownResult(currentRun())).toBeNull();
});

for (const olderFails of [false, true]) {
  for (const newerFails of [false, true]) {
    test(`같은 id의 범위 변경 실행은 늦은 ${olderFails ? "실패" : "성공"}이 최신 ${newerFails ? "실패" : "성공"}을 덮지 않는다`, async () => {
      const first = deferredResponse();
      const second = deferredResponse();
      vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
      const changed: Screen = { ...screen, conditions: [{ kind: "new_high", period: "W", field: "high", n: 60, recentBars: 2 }] };
      const older = useScreenerStore.getState().run(screen);
      const newer = useScreenerStore.getState().run(changed);
      useScreenerStore.getState().choose("other");
      const fresh = { ...result, collectionStartedAt: 100, collectionCompletedAt: 101 };
      second.resolve(newerFails ? failedResponse() : responseOf(fresh));
      await newer;
      const expected = currentRun();
      first.resolve(olderFails ? failedResponse() : responseOf(result));
      await older;
      expect(currentRun()).toEqual(expected);
      expect(runOf(useScreenerStore.getState().runs, screen)).toBeNull();
      expect(shownResult(runOf(useScreenerStore.getState().runs, changed))).toEqual(newerFails ? null : fresh);
    });
  }
}

for (const olderFails of [false, true]) {
  test(`이전 ${olderFails ? "실패" : "성공"}가 먼저 끝나도 더 최신 요청이 진행 중인 상태와 이전 결과를 유지한다`, async () => {
    await useScreenerStore.getState().run(screen);
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const older = useScreenerStore.getState().run(screen);
    const newer = useScreenerStore.getState().run(screen);
    first.resolve(olderFails ? failedResponse() : responseOf({ ...result, collectionStartedAt: 50 }));
    await older;
    expect(currentRun()?.kind).toBe("running");
    expect(shownResult(currentRun())).toEqual(result);
    second.resolve(failedResponse());
    await newer;
    expect(currentRun()?.kind).toBe("failed");
    expect(shownResult(currentRun())).toEqual(result);
  });
}

test("실행식은 호출 경계에서 복사되어 호출자의 중첩 수정과 다른 화면 실행의 영향을 받지 않는다", async () => {
  const gate = deferredResponse();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(responseOf(result)));
  const mutable = structuredClone(screen);
  const pending = useScreenerStore.getState().run(mutable);
  mutable.conditions.length = 0;
  expect(runOf(useScreenerStore.getState().runs, mutable)).toBeNull();
  await useScreenerStore.getState().run({ ...screen, id: "other" });
  gate.resolve(responseOf(result));
  await pending;
  expect(runOf(useScreenerStore.getState().runs, screen)?.kind).toBe("done");
  expect(useScreenerStore.getState().runs.other?.kind).toBe("done");
});

test("필드 순서만 다른 같은 조건식은 같은 실행 결과에 속하고, 내용이 다르면 속하지 않는다", async () => {
  await useScreenerStore.getState().run(screen);
  const reordered: Screen = { conditions: [{ n: 1000, field: "high", recentBars: 20, period: "D", kind: "new_high" }], exclude: [], markets: [], name: screen.name, id: screen.id };
  expect(runOf(useScreenerStore.getState().runs, reordered)?.kind).toBe("done");
  expect(runOf(useScreenerStore.getState().runs, { ...screen, markets: ["kospi"] })).toBeNull();
});
