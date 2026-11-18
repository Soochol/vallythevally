import { expect, test } from "vitest";
import { buildLadder } from "./ladder";
import { expectedInfoItems, placeInfoItems, quoteInfoItems } from "./quoteInfo";

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

const base = quoteInfoItems(known);
const EXPECTED = { price: 71_800, qty: 3_279 };
const expectedItems = expectedInfoItems(EXPECTED, 70_000);
const labels = (slots: ReturnType<typeof placeInfoItems>) => slots.map((item) => item?.label ?? null);

function rowsWithBidAt(...askRows: number[]) {
  const prices = askRows.map((row) => 71_500 + 100 * (11 - row));
  return buildLadder({
    asks: [{ price: 71_600, quantity: 300, change: 0 }],
    bids: [{ price: 71_500, quantity: 450, change: 0 }, ...prices.map((price) => ({ price, quantity: 10, change: 0 }))],
    lastPrice: 71_500,
    previousClose: 70_000,
    bounds: { lower: null, upper: null },
    tickRule: "stock",
  });
}

test("예상체결가는 기준가 대비 등락색이고 예상체결량은 색이 없다", () => {
  expect(expectedItems).toEqual([
    { label: "예상체결가", value: "71,800", tone: "up" },
    { label: "예상체결량", value: "3,279", tone: null },
  ]);
  expect(expectedInfoItems(EXPECTED, 72_000)[0]!.tone).toBe("down");
});

test("예상체결이 없으면 1~7행에 지금 7항목이고 8·9행은 비어 있다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(), base, []))).toEqual(["현재가", "전일대비", "등락률", "거래량", "기준가", "상한가", "하한가", null, null]);
});

test("8·9행에 매수 잔량이 없으면 8행에 예상체결가, 9행에 예상체결량이고 1~7행은 그대로다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(), base, expectedItems))).toEqual(["현재가", "전일대비", "등락률", "거래량", "기준가", "상한가", "하한가", "예상체결가", "예상체결량"]);
});

test("8행에 매수 잔량이 있으면 6·7행의 상한가·하한가 대신 예상체결 두 항목이 온다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(8), base, expectedItems))).toEqual(["현재가", "전일대비", "등락률", "거래량", "기준가", "예상체결가", "예상체결량", null, null]);
});

test("9행에만 매수 잔량이 있어도 두 항목은 6·7행으로 올라간다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(9), base, expectedItems)).slice(5, 9)).toEqual(["예상체결가", "예상체결량", null, null]);
});

test("6·7행에도 매수 잔량이 있으면 두 항목이 칸을 받지 않는다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(6, 7, 8), base, expectedItems))).toEqual(["현재가", "전일대비", "등락률", "거래량", "기준가", null, null, null, null]);
});
