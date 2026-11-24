import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { formatPrice } from "../../lib/format";
import { formatShares, formatWon } from "../market-window/format";

export const POLICY_LABEL: Readonly<Record<MarginPolicy, string>> = { cash_only: "현금", allow_margin: "미수 허용" };

export const MARGIN_CONFIRM_TEXT = "미수를 허용하면 예수금을 넘는 매수가 미수로 나갑니다. 결제일(D+2)까지 입금하지 않으면 반대매매되고, 다음 날부터 30일간 미수동결됩니다.";

export const MARGIN_LOCKED_TEXT = "계좌 증거금률이 100%라 미수를 허용할 수 없습니다";

export const marginLocked = (accountRate: number | null): boolean => accountRate !== null && accountRate >= 100;

export const buyableName = (policy: MarginPolicy | null): string =>
  policy === null ? "매수 가능" : policy === "cash_only" ? "매수 가능 · 현금" : "매수 가능 · 미수 포함";

export const fundsBasis = (orderable: TradingOrderable): string => `${formatPrice(orderable.price, false)}원 기준`;

export type FundsAmountScale = "l" | "m" | "b" | "s";

export interface FundsCard {
  readonly key: "cash" | "margin";
  readonly policy: MarginPolicy;
  readonly name: string;
  readonly tag: string;
  readonly amount: string;
  readonly quantity: string | null;
  readonly zero: boolean;
}

export interface FundsRates {
  readonly applied: string;
  readonly detail: string;
}

export interface FundsView {
  readonly basis: string;
  readonly cards: readonly [FundsCard, FundsCard];
  readonly amountScale: FundsAmountScale;
  readonly deposit: string;
  readonly unpaid: string | null;
  readonly rates: FundsRates | null;
}

const bareRate = (rate: number | null): string => (rate === null ? "-" : String(rate));

const appliedRateText = (rate: number | null): string => (rate === null ? "-" : `${rate}%`);

const amountScaleFor = (longest: number): FundsAmountScale =>
  longest >= 17 ? "s" : longest >= 15 ? "b" : longest >= 12 ? "m" : "l";

function limitCard(
  key: FundsCard["key"],
  policy: MarginPolicy,
  name: string,
  tag: string,
  amount: number | null,
  quantity: number | null,
): FundsCard {
  if (amount === null) return { key, policy, name, tag, amount: "-", quantity: null, zero: false };
  return {
    key,
    policy,
    name,
    tag,
    amount: formatWon(amount),
    quantity: quantity === null ? null : formatShares(quantity),
    zero: quantity === 0,
  };
}

function fundsRates(orderable: TradingOrderable): FundsRates | null {
  if (orderable.stockRate === null && orderable.accountRate === null && orderable.appliedRate === null) return null;
  return {
    applied: appliedRateText(orderable.appliedRate),
    detail: `종목 ${bareRate(orderable.stockRate)} · 계좌 ${bareRate(orderable.accountRate)}`,
  };
}

export function fundsView(orderable: TradingOrderable): FundsView {
  const cash = limitCard("cash", "cash_only", "미수 막기", "현금만", orderable.cashAmount, orderable.cashQuantity);
  const margin = limitCard("margin", "allow_margin", "미수 허용", "미수 포함", orderable.marginAmount, orderable.marginQuantity);
  const longest = Math.max(cash.amount.length, margin.amount.length);
  return {
    basis: fundsBasis(orderable),
    cards: [cash, margin],
    amountScale: amountScaleFor(longest),
    deposit: formatWon(orderable.deposit),
    unpaid: orderable.unpaid > 0 ? formatWon(orderable.unpaid) : null,
    rates: fundsRates(orderable),
  };
}
