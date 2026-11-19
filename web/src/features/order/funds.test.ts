import { expect, test } from "vitest";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { buyableName, fundsRows, fundsTitle, marginLocked } from "./funds";

const orderable: TradingOrderable = {
  accountRef: "synthetic-account", code: "005930", side: "buy", price: 70_000, amount: 1_000_000, quantity: 14, policy: "cash_only",
  cashAmount: 1_000_000, cashQuantity: 14, marginAmount: 3_000_000, marginQuantity: 42, deposit: 1_200_000, unpaid: 0, stockRate: 30, accountRate: 40, appliedRate: 30,
};

test("자금 표는 예수금·현금·미수 포함·증거금률·미수금 순으로 값을 만든다", () => {
  expect(fundsRows(orderable).map((row) => [row.key, row.label, row.value, row.danger])).toEqual([
    ["deposit", "예수금", "1,200,000원", false],
    ["cash", "현금 주문가능 (미수불가)", "1,000,000원 · 14", false],
    ["margin", "미수 포함 주문가능", "3,000,000원 · 42", false],
    ["rates", "증거금률", "종목 30% · 계좌 40% · 적용 30%", false],
    ["unpaid", "미수금", "0원", false],
  ]);
});

test("미수 포함 값이 없으면 -, 증거금률을 모르면 칸마다 -, 미수금이 있으면 위험 표시", () => {
  const rows = fundsRows({ ...orderable, marginAmount: null, marginQuantity: null, stockRate: null, accountRate: null, appliedRate: null, unpaid: 5_000 });
  expect(rows.find((row) => row.key === "margin")?.value).toBe("-");
  expect(rows.find((row) => row.key === "rates")?.value).toBe("종목 - · 계좌 - · 적용 -");
  expect(rows.find((row) => row.key === "unpaid")).toMatchObject({ value: "5,000원", danger: true });
});

test("제목에 조회한 기준 가격을 보이고 칸 이름은 정책을 따른다", () => {
  expect(fundsTitle(orderable)).toBe("자금 · 기준 70,000원");
  expect(buyableName("cash_only")).toBe("매수 가능 · 현금");
  expect(buyableName("allow_margin")).toBe("매수 가능 · 미수 포함");
  expect(buyableName(null)).toBe("매수 가능");
});

test("계좌 증거금률이 100%면 미수 허용을 고를 수 없고 모르면 막지 않는다", () => {
  expect(marginLocked(100)).toBe(true);
  expect(marginLocked(40)).toBe(false);
  expect(marginLocked(null)).toBe(false);
});
