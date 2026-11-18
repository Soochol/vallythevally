import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrderRejectReason } from "../../api/generated/OrderRejectReason";
import { ApiRequestError } from "../../api/http";
import { formatPrice } from "../../lib/format";
import { SIDE_LABEL } from "./orderRules";

export const REJECT_TEXT: Readonly<Record<OrderRejectReason, string>> = {
  orders_off: "주문 사용이 꺼져 있습니다",
  not_connected: "키움에 연결되지 않았습니다",
  auth_blocked: "키움 인증이 막혀 있습니다",
  account_changed: "주문을 켠 뒤 계좌가 바뀌었습니다",
  unknown_pending: "결과를 확인하지 못한 주문이 있어 새 주문을 받지 않습니다",
  invalid_order: "주문 내용이 올바르지 않습니다",
  unknown_symbol: "알 수 없는 종목입니다",
  high_value_unconfirmed: "1억원 이상 주문은 확인이 필요합니다",
  over_single_order_cap: "1회 주문 상한을 넘습니다",
  off_tick: "호가 단위에 맞지 않는 가격입니다",
  out_of_limit: "상·하한가 범위를 벗어난 가격입니다",
  limits_unavailable: "상·하한가를 확인하지 못했습니다",
  sell_over_sellable: "매도 가능 수량을 넘습니다",
  buy_over_buying_power: "매수 가능 금액을 넘습니다",
  nxt_unavailable: "NXT에서 거래되지 않는 종목입니다",
  mock_krx_only: "모의투자는 KRX 주문만 됩니다",
  order_not_found: "정정·취소할 주문을 찾지 못했습니다",
  not_sent: "키움에 보내지 못했습니다",
  kiwoom_rejected: "키움이 주문을 거절했습니다",
  kiwoom_unavailable: "키움이 응답하지 않습니다",
};

export type StatusTone = "info" | "ok" | "error" | "warn";

export interface OrderStatus {
  readonly tone: StatusTone;
  readonly text: string;
  readonly undoOrderNo?: string;
  readonly unknown?: boolean;
}

export const IDLE_STATUS: OrderStatus = { tone: "info", text: "호가 칸을 더블클릭해 주문합니다" };

const describe = (command: OrderCommand): string => {
  const price = command.price !== null ? ` ${formatPrice(command.price, false)}원` : "";
  const quantity = command.quantity !== null ? ` ${command.quantity.toLocaleString("ko-KR")}주` : "";
  const side = command.kind === "buy" || command.kind === "sell" ? SIDE_LABEL[command.kind] : command.kind === "modify" ? "정정" : "취소";
  return `${side}${quantity}${price}`;
};

export function statusOfCommand(command: OrderCommand): OrderStatus {
  switch (command.state) {
    case "accepted":
      return { tone: "ok", text: `접수 · ${describe(command)}`, undoOrderNo: command.kind === "buy" || command.kind === "sell" ? command.orderNo ?? undefined : undefined };
    case "rejected":
      return { tone: "error", text: `거절 · ${command.reason ? REJECT_TEXT[command.reason] : "사유를 알 수 없습니다"}` };
    case "unknown":
      return { tone: "warn", text: "결과를 확인하지 못했습니다", unknown: true };
    default:
      return { tone: "info", text: `줄 서는 중 · ${describe(command)}` };
  }
}

export const isUnanswered = (error: unknown): boolean => !(error instanceof ApiRequestError) || error.code === "network" || error.code === "internal";

export function statusOfFailure(error: unknown): OrderStatus {
  if (!(error instanceof ApiRequestError) || isUnanswered(error)) return { tone: "error", text: "서버의 답을 받지 못했습니다. 같은 동작을 다시 하면 같은 명령으로 보냅니다" };
  return { tone: "error", text: `거절 · ${error.message}` };
}
