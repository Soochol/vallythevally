import { expect, test } from "vitest";
import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrderRejectReason } from "../../api/generated/OrderRejectReason";
import { statusOfCommand } from "./statusText";

const rejected = (reason: OrderRejectReason) => ({ kind: "buy", state: "rejected", reason, quantity: 1, price: 70_000, orderNo: null }) as OrderCommand;

test("한투 계좌의 거절 문구는 한투를 말한다", () => {
  const kis: [OrderRejectReason, string][] = [
    ["not_connected", "거절 · 한투에 연결되지 않았습니다"],
    ["auth_blocked", "거절 · 한투 인증이 막혀 있습니다"],
    ["not_sent", "거절 · 한투에 보내지 못했습니다"],
    ["kiwoom_rejected", "거절 · 한투가 주문을 거절했습니다"],
    ["kiwoom_unavailable", "거절 · 한투가 응답하지 않습니다"],
  ];
  for (const [reason, text] of kis) expect(statusOfCommand(rejected(reason), "kis").text).toBe(text);
  expect(statusOfCommand(rejected("not_connected"), "kiwoom").text).toBe("거절 · 키움에 연결되지 않았습니다");
  expect(statusOfCommand(rejected("kiwoom_rejected"), "kiwoom").text).toBe("거절 · 키움이 주문을 거절했습니다");
  expect(statusOfCommand(rejected("off_tick"), "kis").text).toBe("거절 · 호가 단위에 맞지 않는 가격입니다");
});
