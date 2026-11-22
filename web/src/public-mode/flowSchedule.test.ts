import { describe, expect, test } from "vitest";
import { FLOW_JITTER_MAX_MS, FLOW_JITTER_MIN_MS, FlowRefresh, nextFlowFetchDelayMs } from "./flowSchedule";

const KST_NOON = Date.parse("2026-11-09T12:00:00+09:00");
const MINUTE = 60_000;

describe("공개 모드 흐름을 다시 받는 시각", () => {
  test("다음 KST 분이 바뀐 뒤 2초와 10초 사이에 받는다", () => {
    for (const offset of [0, 1, 29_999, 59_999]) {
      for (const random of [0, 0.25, 0.5, 0.999]) {
        const now = KST_NOON + offset;
        const at = now + nextFlowFetchDelayMs(now, () => random);
        expect(at).toBeGreaterThanOrEqual(KST_NOON + MINUTE + FLOW_JITTER_MIN_MS);
        expect(at).toBeLessThanOrEqual(KST_NOON + MINUTE + FLOW_JITTER_MAX_MS);
      }
    }
  });

  test("분이 바뀌기 직전에 끝난 요청도 바뀐 뒤 2초 이상 기다린다", () => {
    const now = KST_NOON + MINUTE - 1;
    expect(nextFlowFetchDelayMs(now, () => 0)).toBe(1 + FLOW_JITTER_MIN_MS);
  });

  test("무작위 값이 시각을 정한다", () => {
    expect(nextFlowFetchDelayMs(KST_NOON, () => 0)).toBe(MINUTE + FLOW_JITTER_MIN_MS);
    expect(nextFlowFetchDelayMs(KST_NOON, () => 0.5)).toBe(MINUTE + 6_000);
  });
});

describe("흐름을 다시 받는 간격은 한 번 뽑은 값을 유지한다", () => {
  const query = (dataUpdatedAt: number, errorUpdatedAt = 0) => ({ state: { dataUpdatedAt, errorUpdatedAt } });

  test("받은 적이 없으면 간격이 없다", () => {
    expect(new FlowRefresh(() => KST_NOON, () => 0.5).intervalMs(query(0))).toBe(false);
  });

  test("같은 결과를 다시 물어도 같은 값이다. 화면이 다시 그려져도 타이머가 밀리지 않는다", () => {
    let now = KST_NOON;
    let random = 0;
    const refresh = new FlowRefresh(() => now, () => random);
    const settled = query(KST_NOON);
    const first = refresh.intervalMs(settled);
    now += 30_000;
    random = 0.9;
    expect(refresh.intervalMs(settled)).toBe(first);
  });

  test("같은 쿼리에 새 결과가 오면 새로 뽑는다", () => {
    let random = 0;
    const refresh = new FlowRefresh(() => KST_NOON, () => random);
    const settled = query(KST_NOON);
    const quiet = refresh.intervalMs(settled);
    random = 1;
    settled.state.dataUpdatedAt = KST_NOON + 1;
    expect(refresh.intervalMs(settled)).not.toBe(quiet);
  });

  test("오류로 끝난 요청도 결과로 센다", () => {
    expect(new FlowRefresh(() => KST_NOON, () => 0).intervalMs(query(0, KST_NOON))).toBe(MINUTE + FLOW_JITTER_MIN_MS);
  });

  test("쿼리마다 따로 뽑는다", () => {
    let random = 0;
    const refresh = new FlowRefresh(() => KST_NOON, () => random);
    const a = refresh.intervalMs(query(KST_NOON));
    random = 1;
    const b = refresh.intervalMs(query(KST_NOON));
    expect(a).not.toBe(b);
  });
});
