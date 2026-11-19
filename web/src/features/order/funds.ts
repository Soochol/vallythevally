import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { formatPrice } from "../../lib/format";
import { formatQuantity, formatWon } from "../market-window/format";

export const POLICY_LABEL: Readonly<Record<MarginPolicy, string>> = { cash_only: "현금", allow_margin: "미수 허용" };

export const MARGIN_CONFIRM_TEXT = "미수를 허용하면 예수금을 넘는 매수가 미수로 나갑니다. 결제일(D+2)까지 입금하지 않으면 반대매매되고, 다음 날부터 30일간 미수동결됩니다.";

export const MARGIN_LOCKED_TEXT = "계좌가 미수 불가(100%)입니다";

export const marginLocked = (accountRate: number | null): boolean => accountRate !== null && accountRate >= 100;

export const buyableName = (policy: MarginPolicy | null): string =>
  policy === null ? "매수 가능" : policy === "cash_only" ? "매수 가능 · 현금" : "매수 가능 · 미수 포함";

const amountAndQuantity = (amount: number | null, quantity: number | null): string =>
  amount === null || quantity === null ? "-" : `${formatWon(amount)} · ${formatQuantity(quantity)}주`;

const rateText = (rate: number | null): string => (rate === null ? "-" : `${rate}%`);

export interface FundsRow {
  readonly key: "deposit" | "cash" | "margin" | "rates" | "unpaid";
  readonly label: string;
  readonly value: string;
  readonly danger: boolean;
}

export const fundsTitle = (orderable: TradingOrderable): string => `자금 · 기준 ${formatPrice(orderable.price, false)}원`;

export function fundsRows(orderable: TradingOrderable): readonly FundsRow[] {
  const row = (key: FundsRow["key"], label: string, value: string, danger = false): FundsRow => ({ key, label, value, danger });
  return [
    row("deposit", "예수금", formatWon(orderable.deposit)),
    row("cash", "현금 주문가능 (미수불가)", amountAndQuantity(orderable.cashAmount, orderable.cashQuantity)),
    row("margin", "미수 포함 주문가능", amountAndQuantity(orderable.marginAmount, orderable.marginQuantity)),
    row("rates", "증거금률", `종목 ${rateText(orderable.stockRate)} · 계좌 ${rateText(orderable.accountRate)} · 적용 ${rateText(orderable.appliedRate)}`),
    row("unpaid", "미수금", formatWon(orderable.unpaid), orderable.unpaid > 0),
  ];
}
