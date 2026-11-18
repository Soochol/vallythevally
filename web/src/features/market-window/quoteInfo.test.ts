import { expect, test } from "vitest";
import { quoteInfoItems } from "./quoteInfo";

const known = { price: 71_500, previousClose: 70_000, volume: 1_234_567, upperLimit: 91_000, lowerLimit: 49_000 };

test("정보 7항목이 현재가·전일대비·등락률·거래량·기준가·상한가·하한가 순이다", () => {
  const items = quoteInfoItems(known);
  expect(items.map((item) => item.label)).toEqual(["현재가", "전일대비", "등락률", "거래량", "기준가", "상한가", "하한가"]);
  expect(items.map((item) => item.value)).toEqual(["71,500", "+1,500", "+2.14%", "123만", "70,000", "91,000", "49,000"]);
});

test("현재가가 기준가보다 높으면 처음 세 항목이 상승이고 낮으면 하락이다", () => {
  expect(quoteInfoItems(known).map((item) => item.tone)).toEqual(["up", "up", "up", null, null, null, null]);
  expect(quoteInfoItems({ ...known, price: 69_000 }).slice(0, 3).map((item) => item.tone)).toEqual(["down", "down", "down"]);
  expect(quoteInfoItems({ ...known, price: 70_000 }).slice(0, 3).map((item) => item.tone)).toEqual([null, null, null]);
});

test("모르는 값은 대시이고 기준가가 없으면 전일대비도 대시다", () => {
  const items = quoteInfoItems({ price: 71_500, previousClose: null, volume: null, upperLimit: null, lowerLimit: null });
  expect(items.map((item) => item.value)).toEqual(["71,500", "-", "-", "-", "-", "-", "-"]);
});
