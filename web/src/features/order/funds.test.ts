import { expect, test } from "vitest";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { buyableName, fundsBasis, fundsView, MARGIN_LOCKED_TEXT, marginLocked } from "./funds";

const orderable: TradingOrderable = {
  accountRef: "synthetic-account", code: "005930", side: "buy", price: 70_000, amount: 1_000_000, quantity: 14, policy: "cash_only",
  cashAmount: 1_000_000, cashQuantity: 14, marginAmount: 3_000_000, marginQuantity: 42, deposit: 1_200_000, unpaid: 0, stockRate: 30, accountRate: 40, appliedRate: 30,
};

test("자금 화면 자료는 두 카드와 예수금·증거금률을 만들고 미수금이 0이면 비운다", () => {
  expect(fundsView(orderable)).toEqual({
    basis: "70,000원 기준",
    cards: [
      { key: "cash", policy: "cash_only", name: "미수 막기", tag: "현금만", amount: "1,000,000원", quantity: "14주", zero: false },
      { key: "margin", policy: "allow_margin", name: "미수 허용", tag: "미수 포함", amount: "3,000,000원", quantity: "42주", zero: false },
    ],
    amountScale: "l",
    deposit: "1,200,000원",
    unpaid: null,
    rates: { applied: "30%", detail: "종목 30 · 계좌 40" },
  });
});

test("수량이 0이면 zero를 켜고 값이 없으면 금액만 -로 두고 수량을 비운다", () => {
  const view = fundsView({ ...orderable, cashAmount: 117_462, cashQuantity: 0, marginAmount: null, marginQuantity: null });
  expect(view.cards[0]).toMatchObject({ amount: "117,462원", quantity: "0주", zero: true });
  expect(view.cards[1]).toMatchObject({ amount: "-", quantity: null, zero: false });
});

test("미수금은 0보다 클 때만 보이고 증거금률은 모두 모르면 비우며 일부만 모르면 -로 채운다", () => {
  const hidden = fundsView({ ...orderable, stockRate: null, accountRate: null, appliedRate: null, unpaid: 0 });
  expect(hidden.rates).toBeNull();
  expect(hidden.unpaid).toBeNull();

  const partial = fundsView({ ...orderable, stockRate: null, accountRate: 40, appliedRate: null, unpaid: 120_000 });
  expect(partial.rates).toEqual({ applied: "-", detail: "종목 - · 계좌 40" });
  expect(partial.unpaid).toBe("120,000원");
});

test("금액 자릿수가 커질수록 카드 금액 글자 크기 단계를 줄인다", () => {
  expect(fundsView({ ...orderable, cashAmount: 117_462, marginAmount: 124_389 }).amountScale).toBe("l");
  expect(fundsView({ ...orderable, cashAmount: 500_000_000, marginAmount: 1_500_000_000 }).amountScale).toBe("m");
  expect(fundsView({ ...orderable, cashAmount: 12_345_678_900, marginAmount: 98_765_432_100 }).amountScale).toBe("b");
  expect(fundsView({ ...orderable, cashAmount: 1_000_000_000_000, marginAmount: 2_000_000_000_000 }).amountScale).toBe("s");
});

test("기준 가격 문구와 매수 가능 칸 이름, 잠금 문구를 만든다", () => {
  expect(fundsBasis(orderable)).toBe("70,000원 기준");
  expect(buyableName("cash_only")).toBe("매수 가능 · 현금");
  expect(buyableName("allow_margin")).toBe("매수 가능 · 미수 포함");
  expect(buyableName(null)).toBe("매수 가능");
  expect(MARGIN_LOCKED_TEXT).toBe("계좌 증거금률이 100%라 미수를 허용할 수 없습니다");
});

test("계좌 증거금률이 100%면 미수 허용을 고를 수 없고 모르면 막지 않는다", () => {
  expect(marginLocked(100)).toBe(true);
  expect(marginLocked(40)).toBe(false);
  expect(marginLocked(null)).toBe(false);
});
