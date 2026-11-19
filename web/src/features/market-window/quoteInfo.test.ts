import { expect, test } from "vitest";
import { buildLadder } from "./ladder";
import { expectedInfoItems, expectedItemsOnPage, firstShownInfoSlot, nextInfoPage, placeInfoItems, quoteInfoItems } from "./quoteInfo";

const known = {
  price: 70_300,
  previousClose: 70_000,
  summary: { open: 70_100, high: 71_000, low: 69_000, volume: 1_234_567, tradeValueWon: 1_010_300_000_000 },
  fundamentals: { upperLimit: 91_000, lowerLimit: 49_000, high52w: 88_000, low52w: 51_000, marketCap: 82_400_000_000, per: 14.2104, pbr: 1.1, foreignExhaustionRate: 54.123 },
};
const none = { price: null, previousClose: null, summary: null, fundamentals: null };

test("1쪽은 시가·고가·저가·기준가·전일대비·거래량·거래대금 순이고 전일대비에 등락률이 붙는다", () => {
  const items = quoteInfoItems(0, known);
  expect(items.map((item) => item.label)).toEqual(["시가", "고가", "저가", "기준가", "전일대비", "거래량", "거래대금"]);
  expect(items.map((item) => item.value)).toEqual(["70,100", "71,000", "69,000", "70,000", "+300 +0.43%", "123만", "1조 103억"]);
});

test("2쪽은 상한가·하한가·52주 최고·52주 최저·시가총액·PER·PBR·외국인소진율 순이다", () => {
  const items = quoteInfoItems(1, known);
  expect(items.map((item) => item.label)).toEqual(["상한가", "하한가", "52주 최고", "52주 최저", "시가총액", "PER", "PBR", "외국인소진율"]);
  expect(items.map((item) => item.value)).toEqual(["91,000", "49,000", "88,000", "51,000", "824억", "14.21배", "1.10배", "54.12%"]);
});

test("시가·고가·저가·전일대비와 상한가·하한가는 기준가 대비 색이고 나머지는 색이 없다", () => {
  expect(quoteInfoItems(0, known).map((item) => item.tone)).toEqual(["up", "up", "down", null, "up", null, null]);
  expect(quoteInfoItems(1, known).map((item) => item.tone)).toEqual(["up", "down", null, null, null, null, null, null]);
  expect(quoteInfoItems(0, { ...known, price: 69_000 })[4]!.tone).toBe("down");
  expect(quoteInfoItems(0, { ...known, price: 70_000 })[4]).toEqual({ label: "전일대비", value: "0 0.00%", tone: null });
});

test("기준가를 모르면 값은 보이되 색은 없고 전일대비는 대시다", () => {
  const items = quoteInfoItems(0, { ...known, previousClose: null });
  expect(items.map((item) => item.value)).toEqual(["70,100", "71,000", "69,000", "-", "-", "123만", "1조 103억"]);
  expect(items.map((item) => item.tone)).toEqual([null, null, null, null, null, null, null]);
  expect(quoteInfoItems(1, { ...known, previousClose: null }).map((item) => item.tone)).toEqual([null, null, null, null, null, null, null, null]);
});

test("모르는 값은 두 쪽 모두 대시다", () => {
  expect(quoteInfoItems(0, none).map((item) => item.value)).toEqual(["-", "-", "-", "-", "-", "-", "-"]);
  expect(quoteInfoItems(1, none).map((item) => item.value)).toEqual(["-", "-", "-", "-", "-", "-", "-", "-"]);
});

test("거래대금과 시가총액은 조·억·만 순으로 줄이고 1만 미만은 원이다", () => {
  const traded = (tradeValueWon: number) => quoteInfoItems(0, { ...none, summary: { ...known.summary, tradeValueWon } })[6]!.value;
  expect([2_000_000_000_000, 1_000_010_300_000_000, 82_400_000_000, 100_000_000, 52_300_000, 9_999].map(traded)).toEqual(["2조", "1,000조 103억", "824억", "1억", "5,230만", "9,999원"]);
});

test("쪽은 둘이고 다음 쪽은 1쪽과 2쪽을 오간다", () => {
  expect([nextInfoPage(0), nextInfoPage(1)]).toEqual([1, 0]);
});

const base = quoteInfoItems(0, known);
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

test("예상체결이 없으면 1~7행에 1쪽 7항목이고 8·9행은 비어 있다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(), base, []))).toEqual(["시가", "고가", "저가", "기준가", "전일대비", "거래량", "거래대금", null, null]);
});

test("8·9행에 매수 잔량이 없으면 8행에 예상체결가, 9행에 예상체결량이고 1~7행은 그대로다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(), base, expectedItems))).toEqual(["시가", "고가", "저가", "기준가", "전일대비", "거래량", "거래대금", "예상체결가", "예상체결량"]);
});

test("8행에 매수 잔량이 있으면 6·7행의 거래량·거래대금 대신 예상체결 두 항목이 온다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(8), base, expectedItems))).toEqual(["시가", "고가", "저가", "기준가", "전일대비", "예상체결가", "예상체결량", null, null]);
});

test("9행에만 매수 잔량이 있어도 두 항목은 6·7행으로 올라간다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(9), base, expectedItems)).slice(5, 9)).toEqual(["예상체결가", "예상체결량", null, null]);
});

test("6·7행에도 매수 잔량이 있으면 두 항목이 칸을 받지 않는다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(6, 7, 8), base, expectedItems))).toEqual(["시가", "고가", "저가", "기준가", "전일대비", null, null, null, null]);
});

test("예상체결 항목은 1쪽에만 있고 2쪽과 예상체결이 없을 때는 비어 있다", () => {
  expect(expectedItemsOnPage(0, EXPECTED, 70_000)).toEqual(expectedItems);
  expect(expectedItemsOnPage(1, EXPECTED, 70_000)).toEqual([]);
  expect(expectedItemsOnPage(0, null, 70_000)).toEqual([]);
});

test("2쪽 8항목은 예상체결이 없으므로 1~8행을 차지하고 9행은 비어 있다", () => {
  expect(labels(placeInfoItems(rowsWithBidAt(), quoteInfoItems(1, known), []))).toEqual(["상한가", "하한가", "52주 최고", "52주 최저", "시가총액", "PER", "PBR", "외국인소진율", null]);
});

test("키보드 초점 칸은 그려지는 첫 정보 칸이고 맨 윗행에 매수 잔량이 있으면 그 다음 칸이다", () => {
  const plain = rowsWithBidAt();
  expect(firstShownInfoSlot(plain, placeInfoItems(plain, base, []))).toBe(0);
  const crossed = rowsWithBidAt(1);
  expect(crossed[0]!.bid).not.toBeNull();
  expect(firstShownInfoSlot(crossed, placeInfoItems(crossed, base, []))).toBe(1);
});
