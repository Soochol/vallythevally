import { expect, test } from "vitest";
import { buildLadder } from "./ladder";
import { expectedInfoItems, expectedItemsOnPage, infoCardRows, type InfoLine, otherInfoPage, placeInfoItems, quoteInfoItems } from "./quoteInfo";

const known = {
  price: 70_300,
  previousClose: 70_000,
  summary: { open: 70_100, high: 71_000, low: 69_000, volume: 1_234_567, tradeValueWon: 1_010_300_000_000 },
  fundamentals: { upperLimit: 91_000, lowerLimit: 49_000, high52w: 88_000, low52w: 51_000, marketCap: 82_400_000_000, per: 14.2104, pbr: 1.1, foreignExhaustionRate: 54.123 },
};
const none = { price: null, previousClose: null, summary: null, fundamentals: null };

const items = (lines: readonly InfoLine[]) => lines.flatMap((line) => (line.kind === "item" ? [line.item] : []));
const shape = (lines: readonly InfoLine[]) => lines.map((line) => (line.kind === "item" ? line.item.label : line.kind));

test("시세 쪽은 시가·고가·저가, 당일 범위 막대, 기준가·전일대비·거래량·거래대금 순이고 전일대비에 등락률이 붙는다", () => {
  const lines = quoteInfoItems(0, known);
  expect(shape(lines)).toEqual(["시가", "고가", "저가", "range", "기준가", "전일대비", "거래량", "거래대금"]);
  expect(items(lines).map((item) => item.value)).toEqual(["70,100", "71,000", "69,000", "70,000", "+300 +0.43%", "123만", "1조 103억"]);
  expect(lines[3]).toEqual({ kind: "range", label: "당일 범위", position: (70_300 - 69_000) / 2_000 });
});

test("종목 쪽은 상한가·하한가, 52주 범위 막대와 양 끝 값, 시가총액, PER·PBR 한 줄, 외국인소진율 순이다", () => {
  const lines = quoteInfoItems(1, known);
  expect(shape(lines)).toEqual(["상한가", "하한가", "range", "ends", "시가총액", "PER·PBR", "외국인소진율"]);
  expect(items(lines).map((item) => item.value)).toEqual(["91,000", "49,000", "824억", "14.21·1.10", "54.12%"]);
  expect(lines[2]).toEqual({ kind: "range", label: "52주 범위", position: (70_300 - 51_000) / 37_000 });
  expect(lines[3]).toEqual({ kind: "ends", low: "51,000", high: "88,000" });
});

test("시가·고가·저가·전일대비와 상한가·하한가는 기준가 대비 색이고 나머지는 색이 없다", () => {
  expect(items(quoteInfoItems(0, known)).map((item) => item.tone)).toEqual(["up", "up", "down", null, "up", null, null]);
  expect(items(quoteInfoItems(1, known)).map((item) => item.tone)).toEqual(["up", "down", null, null, null]);
  expect(items(quoteInfoItems(0, { ...known, price: 69_000 }))[4]!.tone).toBe("down");
  expect(items(quoteInfoItems(0, { ...known, price: 70_000 }))[4]).toEqual({ label: "전일대비", value: "0 0.00%", tone: null });
});

test("전일대비는 오르내릴 때만 색 띠가 붙는다", () => {
  const band = (price: number) => items(quoteInfoItems(0, { ...known, price }))[4]!.band;
  expect([band(70_300), band(69_000), band(70_000)]).toEqual([true, true, undefined]);
});

test("기준가를 모르면 값은 보이되 색은 없고 전일대비는 대시다", () => {
  const lines = items(quoteInfoItems(0, { ...known, previousClose: null }));
  expect(lines.map((item) => item.value)).toEqual(["70,100", "71,000", "69,000", "-", "-", "123만", "1조 103억"]);
  expect(lines.map((item) => item.tone)).toEqual([null, null, null, null, null, null, null]);
  expect(items(quoteInfoItems(1, { ...known, previousClose: null })).map((item) => item.tone)).toEqual([null, null, null, null, null]);
});

test("모르는 값은 두 쪽 모두 대시이고 범위 막대는 없다", () => {
  expect(quoteInfoItems(0, none).map((line) => line.kind)).toEqual(Array(7).fill("item"));
  expect(items(quoteInfoItems(0, none)).map((item) => item.value)).toEqual(["-", "-", "-", "-", "-", "-", "-"]);
  expect(quoteInfoItems(1, none).map((line) => line.kind)).toEqual(Array(6).fill("item"));
  expect(items(quoteInfoItems(1, none)).map((item) => item.value)).toEqual(["-", "-", "-", "-", "-", "-"]);
});

test("PER과 PBR 중 하나만 모르면 그 자리만 대시다", () => {
  const per = (value: number | null, pbr: number | null) => items(quoteInfoItems(1, { ...known, fundamentals: { ...known.fundamentals, per: value, pbr } }))[3]!.value;
  expect([per(14.2104, null), per(null, 1.1)]).toEqual(["14.21·-", "-·1.10"]);
});

test("당일 범위 막대는 고가·저가가 모두 있을 때만 있고 현재가 위치는 (현재가−저가)/(고가−저가)다", () => {
  const position = (summary: { high?: number | null; low?: number | null }, price: number | null = 70_300) => {
    const line = quoteInfoItems(0, { ...known, price, summary: { ...known.summary, ...summary } as typeof known.summary }).find((entry) => entry.kind === "range");
    return line?.kind === "range" ? line.position : "none";
  };
  expect(position({})).toBeCloseTo(0.65);
  expect(position({ high: null })).toBe("none");
  expect(position({ low: null })).toBe("none");
  expect(position({ high: 68_000 })).toBe("none");
  expect(position({}, null)).toBeNull();
  expect(position({}, 72_000)).toBe(1);
  expect(position({}, 60_000)).toBe(0);
  expect(position({ high: 70_000, low: 70_000 }, 70_000)).toBe(0.5);
});

test("거래대금과 시가총액은 조·억·만 순으로 줄이고 1만 미만은 원이다", () => {
  const traded = (tradeValueWon: number) => items(quoteInfoItems(0, { ...none, summary: { ...known.summary, tradeValueWon } }))[6]!.value;
  expect([2_000_000_000_000, 1_000_010_300_000_000, 82_400_000_000, 100_000_000, 52_300_000, 9_999].map(traded)).toEqual(["2조", "1,000조 103억", "824억", "1억", "5,230만", "9,999원"]);
});

test("쪽은 둘이고 다른 쪽은 시세와 종목을 오간다", () => {
  expect([otherInfoPage(0), otherInfoPage(1)]).toEqual([1, 0]);
});

const base = quoteInfoItems(0, known);
const EXPECTED = { price: 71_800, qty: 3_279 };
const expectedItems = expectedInfoItems(EXPECTED);

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

test("예상체결 두 항목은 경고색이다", () => {
  expect(expectedItems).toEqual([
    { label: "예상체결가", value: "71,800", tone: "warning" },
    { label: "예상체결량", value: "3,279", tone: "warning" },
  ]);
});

test("카드는 사다리 1~9행 자리이고 매수 잔량이 있는 첫 행 위까지만 쓴다", () => {
  expect(infoCardRows(rowsWithBidAt())).toBe(9);
  expect(infoCardRows(rowsWithBidAt(8))).toBe(7);
  expect(infoCardRows(rowsWithBidAt(1))).toBe(0);
  expect(infoCardRows(rowsWithBidAt(6, 7, 8))).toBe(5);
});

test("예상체결이 없으면 탭 줄을 뺀 8줄 자리에 시세 쪽이 다 들어간다", () => {
  expect(shape(placeInfoItems(rowsWithBidAt(), base, []))).toEqual(["시가", "고가", "저가", "range", "기준가", "전일대비", "거래량", "거래대금"]);
});

test("예상체결이 있으면 카드 맨 아래 두 줄에 놓이고 그 앞 줄이 밀려난다", () => {
  expect(shape(placeInfoItems(rowsWithBidAt(), base, expectedItems))).toEqual(["시가", "고가", "저가", "range", "기준가", "전일대비", "예상체결가", "예상체결량"]);
});

test("8행에 매수 잔량이 있으면 카드가 7행으로 줄어 예상체결 두 줄이 그 위 끝에 온다", () => {
  expect(shape(placeInfoItems(rowsWithBidAt(8), base, expectedItems))).toEqual(["시가", "고가", "저가", "range", "예상체결가", "예상체결량"]);
});

test("6행에 매수 잔량이 있으면 카드가 5행이라 시세 두 줄과 예상체결 두 줄만 남는다", () => {
  expect(shape(placeInfoItems(rowsWithBidAt(6, 7, 8), base, expectedItems))).toEqual(["시가", "고가", "예상체결가", "예상체결량"]);
});

test("카드에 탭 줄 말고 한 줄만 남으면 예상체결 없이 시세 줄을 보이고 첫 행이 교차면 카드가 없다", () => {
  expect(shape(placeInfoItems(rowsWithBidAt(3), base, expectedItems))).toEqual(["시가"]);
  expect(placeInfoItems(rowsWithBidAt(1), base, expectedItems)).toEqual([]);
});

test("예상체결 항목은 시세 쪽에만 있고 종목 쪽과 예상체결이 없을 때는 비어 있다", () => {
  expect(expectedItemsOnPage(0, EXPECTED)).toEqual(expectedItems);
  expect(expectedItemsOnPage(1, EXPECTED)).toEqual([]);
  expect(expectedItemsOnPage(0, null)).toEqual([]);
});
