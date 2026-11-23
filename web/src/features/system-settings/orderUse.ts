import type { Broker } from "../../api/generated/Broker";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { OrdersState } from "../../api/generated/OrdersState";
import type { OrdersStatus } from "../../api/generated/OrdersStatus";

export const NO_ACCOUNT_TEXT = "켤 때 확인";
export const REMOVE_ORDERS_NOTE = "주문 사용이 꺼지고, 이 계좌를 고른 호가주문창은 시세 공급원 계좌로 돌아갑니다";

export function enableTail(broker: Broker, serverTail: string | null, typedTail: string): string | null {
  if (broker === "kiwoom") return serverTail;
  return /^\d{2}$/.test(typedTail) ? typedTail : null;
}

export const canConfirmEnable = (broker: Broker, accountConfirmed: boolean, typedTail: string): boolean => (broker === "kiwoom" ? accountConfirmed : enableTail(broker, null, typedTail) !== null);

export const accountNumberOf = (tail: string | null): string => (tail === null ? NO_ACCOUNT_TEXT : `****-**${tail}`);

export function orderMarkOf(state: OrdersState): { readonly text: string; readonly tone: "on" | "off" | "warn" } {
  switch (state) {
    case "on":
      return { text: "주문 켜짐", tone: "on" };
    case "account_changed":
      return { text: "계좌 바뀜", tone: "warn" };
    case "off":
    case "file_unusable":
      return { text: "주문 꺼짐", tone: "off" };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export const orderCanTurnOn = (state: OrdersState): boolean => state === "off" || state === "account_changed";
export const orderCanTurnOff = (state: OrdersState): boolean => state === "on" || state === "account_changed";
export const orderInUse = (account: OrdersAccount | undefined): boolean => account !== undefined && orderCanTurnOff(account.state);

export function mergeOrdersStatus(old: OrdersStatus | undefined, result: OrdersStatus, market: boolean): OrdersStatus {
  return old === undefined || market ? result : { ...old, accounts: result.accounts };
}
