import { describe, expect, test } from "vitest";
import { FLOW_JITTER_MAX_MS, FLOW_JITTER_MIN_MS, nextFlowFetchDelayMs } from "./flowSchedule";

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
