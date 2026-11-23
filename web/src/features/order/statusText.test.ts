import { expect, test } from "vitest";
import { ApiRequestError } from "../../api/http";
import type { OrderCommand } from "../../api/generated/OrderCommand";
import { isUnanswered, statusOfCanceling, statusOfCommand, PENDING_CHIP_TEXT, RETRY_LABEL, statusOfFailure, statusOfModifying, statusOfSending } from "./statusText";

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

test("접수 문구는 수량과 가격을 단위 없이 가운뎃점으로 잇는다", () => {
  const command = { kind: "buy", state: "accepted", quantity: 10, price: 70_000, orderNo: null } as OrderCommand;
  expect(statusOfCommand(command, "kiwoom").text).toBe("접수 · 매수 10 · 70,000원");
  expect(statusOfCommand({ ...command, price: null }, "kiwoom").text).toBe("접수 · 매수 10");
  expect(statusOfCommand({ ...command, kind: "cancel", quantity: null, price: null }, "kiwoom").text).toBe("접수 · 취소");
});

test("보내는 중·취소 중·정정 중 문구", () => {
  expect(statusOfSending("buy", 10, 70_000).text).toBe("보내는 중 · 매수 10 · 70,000원");
  expect(statusOfCanceling().text).toBe("취소 중");
  expect(statusOfCanceling({ side: "sell", price: 70_100 }).text).toBe("취소 중 · 매도 70,100원");
  expect(statusOfModifying(70_000, 70_100).text).toBe("정정 중 · 70,000원 → 70,100원");
});

test("답을 못 받은 실패에만 다시 보내기가 붙고 누르면 넘겨 준 동작을 부른다", () => {
  let sent = 0;
  const retry = () => { sent += 1; };
  const unanswered = statusOfFailure(new ApiRequestError("network", "서버에 연결하지 못했습니다"), retry);
  expect(unanswered.tone).toBe("error");
  expect(unanswered.action?.label).toBe(RETRY_LABEL);
  unanswered.action?.run();
  expect(sent).toBe(1);
  expect(statusOfFailure(new ApiRequestError("network", "x")).action).toBeUndefined();
  expect(statusOfFailure(new ApiRequestError("conflict", "주문 사용이 꺼져 있습니다"), retry).action).toBeUndefined();
});

test("진행 중 칩 글자는 보냄·취소·정정이다", () => {
  expect(PENDING_CHIP_TEXT).toEqual({ sending: "보냄…", canceling: "취소…", modifying: "정정…" });
});
