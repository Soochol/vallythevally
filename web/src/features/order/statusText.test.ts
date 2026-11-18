import { expect, test } from "vitest";
import { ApiRequestError } from "../../api/http";
import { isUnanswered, statusOfFailure } from "./statusText";

test("서버의 답을 읽지 못한 실패는 답을 못 받은 것으로 본다", () => {
  expect(isUnanswered(new ApiRequestError("network", "서버에 연결하지 못했습니다"))).toBe(true);
  expect(isUnanswered(new ApiRequestError("internal", "서버가 응답하지 못했습니다"))).toBe(true);
  expect(isUnanswered(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
});

test("서버가 판단을 내린 거절은 답을 받은 것이다", () => {
  const rejected = new ApiRequestError("conflict", "주문 사용이 꺼져 있습니다");
  expect(isUnanswered(rejected)).toBe(false);
  expect(statusOfFailure(rejected).text).toBe("거절 · 주문 사용이 꺼져 있습니다");
});
