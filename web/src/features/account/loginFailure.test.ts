import { describe, expect, test } from "vitest";
import { loginFailureText, takeLoginFailure } from "./loginFailure";

describe("로그인 실패 이유 문장", () => {
  test("서버가 돌려주는 이유마다 문장이 있다", () => {
    const reasons = ["state", "cancelled", "idp_failed", "bad_request", "local_only", "exchange_failed", "server_unreachable", "storage"];
    const texts = reasons.map(loginFailureText);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(reasons.length);
  });

  test("취소는 오류처럼 보이지 않는 문장이다", () => {
    expect(loginFailureText("cancelled")).toBe("로그인을 취소했습니다");
    expect(loginFailureText("access_denied")).toBe("로그인을 취소했습니다");
  });

  test("모르는 이유와 이유 없음은 일반 문장이다", () => {
    expect(loginFailureText("nope")).toBe(loginFailureText(null));
    expect(loginFailureText("toString")).toBe(loginFailureText(null));
  });
});

describe("돌아온 주소 읽기", () => {
  test("실패 쿼리를 지운 주소를 준다", () => {
    expect(takeLoginFailure(new URL("http://127.0.0.1:8080/?login=error&reason=access_denied"))).toEqual({ text: "로그인을 취소했습니다", cleaned: "/" });
  });

  test("다른 쿼리와 해시는 남긴다", () => {
    expect(takeLoginFailure(new URL("http://127.0.0.1:8080/?symbol=005930&login=error&reason=storage#x"))?.cleaned).toBe("/?symbol=005930#x");
  });

  test("실패로 돌아온 것이 아니면 건드리지 않는다", () => {
    expect(takeLoginFailure(new URL("http://127.0.0.1:8080/?symbol=005930"))).toBeNull();
    expect(takeLoginFailure(new URL("http://127.0.0.1:8080/?reason=storage"))).toBeNull();
  });
});
