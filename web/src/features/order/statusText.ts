import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { OrderRejectReason } from "../../api/generated/OrderRejectReason";
import { ApiRequestError } from "../../api/http";
import { formatPrice } from "../../lib/format";
import { SIDE_LABEL } from "./orderRules";
import type { PendingState } from "./pendingWrites";

export const MARGIN_SETTLEMENT_TEXT = "결제일(D+2)까지 입금";

export const MOCK_KRX_ONLY_TEXT = "모의투자는 KRX 주문만 됩니다";

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
  mock_krx_only: MOCK_KRX_ONLY_TEXT,
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
  readonly fades?: boolean;
  readonly action?: { readonly label: string; readonly run: () => void };
}

const describe = (command: OrderCommand): string => {
  const price = command.price !== null ? `${formatPrice(command.price, false)}원` : null;
  const quantity = command.quantity !== null ? command.quantity.toLocaleString("ko-KR") : null;
  const side = command.kind === "buy" || command.kind === "sell" ? SIDE_LABEL[command.kind] : command.kind === "modify" ? "정정" : "취소";
  const figures = [quantity, price].filter((figure) => figure !== null).join(" · ");
  return figures === "" ? side : `${side} ${figures}`;
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

export function withMargin(status: OrderStatus, margin: number): OrderStatus {
  if (margin <= 0 || status.tone !== "ok") return status;
  return { ...status, tone: "warn", fades: true, text: `${status.text} · 미수 약 ${margin.toLocaleString("ko-KR")}원, ${MARGIN_SETTLEMENT_TEXT}` };
}

export const PENDING_TEXT: Readonly<Record<PendingState, string>> = { sending: "보내는 중", canceling: "취소 중", modifying: "정정 중" };

export const PENDING_CHIP_TEXT: Readonly<Record<PendingState, string>> = { sending: "보냄…", canceling: "취소…", modifying: "정정…" };

export const RETRY_LABEL = "다시 보내기";

const won = (price: number): string => `${formatPrice(price, false)}원`;

export const statusOfSending = (side: OrderSide, quantity: number, price: number): OrderStatus =>
  ({ tone: "info", text: `${PENDING_TEXT.sending} · ${SIDE_LABEL[side]} ${quantity.toLocaleString("ko-KR")} · ${won(price)}` });

export const statusOfCanceling = (target?: { readonly side: OrderSide; readonly price: number }): OrderStatus =>
  ({ tone: "info", text: target ? `${PENDING_TEXT.canceling} · ${SIDE_LABEL[target.side]} ${won(target.price)}` : PENDING_TEXT.canceling });

export const statusOfModifying = (from: number, to: number): OrderStatus =>
  ({ tone: "info", text: `${PENDING_TEXT.modifying} · ${won(from)} → ${won(to)}` });

export const isUnanswered = (error: unknown): boolean => !(error instanceof ApiRequestError) || error.code === "network" || error.code === "internal";

export function statusOfFailure(error: unknown, retry?: () => void): OrderStatus {
  if (!(error instanceof ApiRequestError) || isUnanswered(error)) {
    const text = "서버의 답을 받지 못했습니다. 다시 보내면 같은 명령으로 보냅니다";
    return retry ? { tone: "error", text, action: { label: RETRY_LABEL, run: retry } } : { tone: "error", text };
  }
  return { tone: "error", text: `거절 · ${error.message}` };
}
