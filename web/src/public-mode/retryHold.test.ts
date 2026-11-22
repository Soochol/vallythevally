import { describe, expect, test } from "vitest";
import { RetryHold } from "./retryHold";

const error = (retryAt: number | null) => ({ retryAt });

describe("retryAt이 지나기 전의 같은 요청", () => {
  test("429의 retryAt 전에는 같은 요청을 막고 같은 오류를 돌려준다", () => {
    let now = 1_000_000;
    const hold = new RetryHold(() => now);
    const key = RetryHold.keyOf("GET", "/api/heatmap/flow?x=1");
    const failure = error(1_010);
    hold.note(key, 429, failure);
    expect(hold.heldError(key)).toBe(failure);
    now = 1_009_999;
    expect(hold.heldError(key)).toBe(failure);
    now = 1_010_000;
    expect(hold.heldError(key)).toBeNull();
  });

  test("503도 막고 그 밖의 상태나 retryAt 없는 오류는 막지 않는다", () => {
    const hold = new RetryHold(() => 0);
    hold.note("a", 503, error(10));
    hold.note("b", 500, error(10));
    hold.note("c", 429, error(null));
    expect(hold.heldError("a")).not.toBeNull();
    expect(hold.heldError("b")).toBeNull();
    expect(hold.heldError("c")).toBeNull();
  });

  test("다른 경로는 막지 않는다", () => {
    const hold = new RetryHold(() => 0);
    hold.note(RetryHold.keyOf("POST", "/api/rankings"), 429, error(10));
    expect(hold.heldError(RetryHold.keyOf("GET", "/api/rankings"))).toBeNull();
  });
});
