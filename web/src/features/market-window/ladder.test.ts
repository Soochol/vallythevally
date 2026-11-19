import { expect, test } from "vitest";
import { basePrice, buildDefaultLadder, buildLadder, buildLadderRows, defaultLadderPrices, gridPrices, isSinglePriceBook, LADDER_ROWS, ratioSplit, type BookLevel } from "./ladder";
import { expectedInfoItems, placeInfoItems, quoteInfoItems } from "./quoteInfo";

const NO_BOUNDS = { lower: null, upper: null };
const level = (price: number, quantity: number, change = 0): BookLevel => ({ price, quantity, change });
const build = (input: Partial<Parameters<typeof buildLadder>[0]>) => buildLadder({ asks: [], bids: [], lastPrice: null, previousClose: null, bounds: NO_BOUNDS, tickRule: "stock", ...input });
const prices = (rows: ReturnType<typeof buildLadder>) => rows.map((row) => row.price);
const rowAt = (rows: ReturnType<typeof buildLadder>, price: number) => rows.find((row) => row.price === price)!;

test("기준 가격 위 10틱과 아래 10행(기준 포함)의 가격이 나온다", () => {
  const rows = build({ lastPrice: 70_000 });
  expect(rows).toHaveLength(LADDER_ROWS);
  expect(prices(rows)).toEqual([
    71_000, 70_900, 70_800, 70_700, 70_600, 70_500, 70_400, 70_300, 70_200, 70_100,
    70_000, 69_900, 69_800, 69_700, 69_600, 69_500, 69_400, 69_300, 69_200, 69_100,
  ]);
});

test("틱 경계(20,000원 아래 10원, 위 50원)를 넘는 격자가 맞는 틱으로 이어진다", () => {
  const rows = build({ lastPrice: 20_000 });
  expect(prices(rows)).toEqual([
    20_500, 20_450, 20_400, 20_350, 20_300, 20_250, 20_200, 20_150, 20_100, 20_050,
    20_000, 19_990, 19_980, 19_970, 19_960, 19_950, 19_940, 19_930, 19_920, 19_910,
  ]);
});

test("교차 호가(매도 1호가 ≤ 매수 1호가)는 같은 가격 행에 매도·매수 잔량이 함께 있고 같은 가격 행이 둘이 아니다", () => {
  const rows = build({ asks: [level(70_000, 30), level(70_100, 20)], bids: [level(70_100, 25), level(70_000, 15)], lastPrice: 70_100 });
  const shown = prices(rows).filter((price) => price !== null);
  expect(new Set(shown).size).toBe(shown.length);
  expect([rowAt(rows, 70_100).ask?.quantity, rowAt(rows, 70_100).bid?.quantity]).toEqual([20, 25]);
  expect([rowAt(rows, 70_000).ask?.quantity, rowAt(rows, 70_000).bid?.quantity]).toEqual([30, 15]);
  expect(rows.filter((row) => row.current).map((row) => row.price)).toEqual([70_100]);
});

test("상한·하한 밖의 행은 빈 행이다", () => {
  const nearUpper = build({ lastPrice: 70_800, bounds: { lower: 49_000, upper: 71_000 } });
  expect(prices(nearUpper).slice(0, 10)).toEqual([null, null, null, null, null, null, null, null, 71_000, 70_900]);
  const nearLower = build({ lastPrice: 50_000, bounds: { lower: 49_900, upper: 91_000 } });
  expect(prices(nearLower).slice(-10)).toEqual([50_000, 49_950, 49_900, null, null, null, null, null, null, null]);
  expect(nearUpper.filter((row) => row.price === null).every((row) => row.ask === null && row.bid === null && row.rate === null)).toBe(true);
});

test("현재가가 없으면 매수 1호가, 그것도 없으면 기준가가 기준이다", () => {
  const quotes = { asks: [level(70_100, 5)], bids: [level(69_800, 3), level(70_000, 7)], previousClose: 69_000 };
  expect(basePrice({ ...quotes, lastPrice: 70_500 })).toBe(70_500);
  expect(basePrice({ ...quotes, lastPrice: null })).toBe(70_000);
  expect(basePrice({ asks: quotes.asks, bids: [], lastPrice: null, previousClose: 69_000 })).toBe(69_000);
  expect(basePrice({ asks: [], bids: [], lastPrice: null, previousClose: null })).toBeNull();
  expect(prices(build({ ...quotes, lastPrice: null }))[10]).toBe(70_000);
  expect(prices(build({ lastPrice: null })).every((price) => price === null)).toBe(true);
});

test("받은 단 가운데 격자에 들지 않는 가격은 행에 없다", () => {
  const rows = build({ asks: [level(71_000, 1), level(71_100, 2)], bids: [level(69_100, 3), level(69_000, 4), level(70_050, 5)], lastPrice: 70_000 });
  expect(rows.some((row) => row.ask?.price === 71_100 || row.bid?.price === 69_000)).toBe(false);
  expect(rows.filter((row) => row.ask || row.bid).map((row) => row.price)).toEqual([71_000, 69_100]);
});

test("막대 비율은 보이는 행의 최대 잔량 기준이다", () => {
  const rows = build({ asks: [level(70_100, 50), level(70_200, 400)], bids: [level(70_000, 200)], lastPrice: 70_000 });
  expect([rowAt(rows, 70_100).askRatio, rowAt(rows, 70_200).askRatio, rowAt(rows, 70_000).bidRatio]).toEqual([0.125, 1, 0.5]);
  expect(rows.filter((row) => !row.ask && !row.bid).every((row) => row.askRatio === 0 && row.bidRatio === 0)).toBe(true);
});

test("격자 밖 먼 호가는 막대 기준에 들지 않는다", () => {
  const rows = build({ asks: [level(70_100, 10), level(75_000, 1_000_000)], bids: [], lastPrice: 70_000 });
  expect(rowAt(rows, 70_100).askRatio).toBe(1);
});

test("현재가 행만 표시하고 등락률은 전일 종가 기준으로 값이 있는 모든 행에 있다", () => {
  const rows = build({ lastPrice: 70_000, previousClose: 56_000 });
  expect(rows.filter((row) => row.current).map((row) => row.price)).toEqual([70_000]);
  expect(rowAt(rows, 70_000).rate).toBe(25);
  expect(rowAt(rows, 70_100).rate).toBeCloseTo(25.1786, 3);
  expect(rows.every((row) => row.rate !== null)).toBe(true);
});

test("전일 종가가 없으면 등락률도 없고 빈 행도 등락률이 없다", () => {
  const rows = build({ lastPrice: 70_000, bounds: { lower: 69_000, upper: 70_300 } });
  expect(rows.every((row) => row.rate === null)).toBe(true);
});

test("잔량에 NaN·음수가 있어도 나머지 막대는 정상이고 그 행은 0이다", () => {
  const rows = build({ asks: [level(70_100, Number.NaN), level(70_200, -5)], bids: [level(70_000, 8), level(69_900, 4)], lastPrice: 70_000 });
  expect([rowAt(rows, 70_200).askRatio, rowAt(rows, 70_100).askRatio, rowAt(rows, 70_000).bidRatio, rowAt(rows, 69_900).bidRatio]).toEqual([0, 0, 1, 0.5]);
});

test("격자 가격 목록은 기준이 없으면 모두 비고 있으면 내림차순이다", () => {
  expect(gridPrices(null, NO_BOUNDS, "stock")).toEqual(Array(LADDER_ROWS).fill(null));
  const listed = gridPrices(70_000, NO_BOUNDS, "stock") as number[];
  expect(listed).toEqual([...listed].sort((a, b) => b - a));
});

test("가격 목록을 직접 주면 그 가격으로 행을 만든다", () => {
  const rows = buildLadderRows([70_300, 70_200, null], { asks: [level(70_200, 40)], bids: [], lastPrice: 70_300, previousClose: 70_000 });
  expect(rows.map((row) => [row.price, row.ask?.quantity ?? null, row.current])).toEqual([[70_300, null, true], [70_200, 40, false], [null, null, false]]);
});

test("매수·매도 비율은 합이 100이고 둘 다 0이면 반반이다", () => {
  expect(ratioSplit(3, 1)).toEqual({ buy: 75, sell: 25 });
  expect(ratioSplit(0, 0)).toEqual({ buy: 50, sell: 50 });
});

test("ETF 호가 단위(2,000원 이상 5원)로 만든 격자에 받은 스무 단이 모두 자기 행에 있다", () => {
  const asks = Array.from({ length: 10 }, (_, i) => level(35_010 + 5 * i, 100 + i));
  const bids = Array.from({ length: 10 }, (_, i) => level(35_005 - 5 * i, 200 + i));
  const rows = build({ asks, bids, lastPrice: 35_005, tickRule: "etf" });
  expect(prices(rows)[0]).toBe(35_055);
  expect(prices(rows)[10]).toBe(35_005);
  expect(prices(rows)[19]).toBe(34_960);
  expect(rows.filter((row) => row.ask || row.bid)).toHaveLength(20);
  expect(rows.filter((row) => row.ask && row.bid)).toHaveLength(0);
});

test("기준 가격이 0·NaN·음수이면 매수 1호가, 그것도 못 쓰면 기준가로 넘어간다", () => {
  const bids = [level(70_000, 3), level(69_900, 4)];
  for (const lastPrice of [0, Number.NaN, -100]) {
    expect(basePrice({ asks: [], bids, lastPrice, previousClose: 69_000 })).toBe(70_000);
    expect(basePrice({ asks: [], bids: [], lastPrice, previousClose: 69_000 })).toBe(69_000);
    expect(basePrice({ asks: [], bids: [], lastPrice, previousClose: Number.NaN })).toBeNull();
  }
  expect(basePrice({ asks: [], bids: [level(Number.NaN, 1), level(0, 1), level(69_900, 4)], lastPrice: null, previousClose: null })).toBe(69_900);
  expect(prices(build({ bids, lastPrice: 0 }))[10]).toBe(70_000);
});

test("같은 가격의 단이 둘이면 잔량과 증감을 합친다", () => {
  const rows = build({ asks: [level(70_100, 5, 1), level(70_100, 7, 2)], bids: [], lastPrice: 70_000 });
  expect(rowAt(rows, 70_100).ask).toEqual({ price: 70_100, quantity: 12, change: 3 });
  expect(rowAt(rows, 70_100).askRatio).toBe(1);
});

const CAPTURE_ASKS = [level(821_000, 418), level(820_000, 1_533), level(819_000, 934)];
const CAPTURE_BIDS = [level(818_000, 3_012), level(817_000, 61), level(816_000, 57)];
const auction = (input: Partial<Parameters<typeof buildDefaultLadder>[0]> = {}) => buildDefaultLadder({ asks: CAPTURE_ASKS, bids: CAPTURE_BIDS, lastPrice: 810_000, previousClose: 810_000, bounds: { lower: 567_000, upper: 1_053_000 }, tickRule: "stock", ...input });

test("동시호가 캡처: 매도 3단은 가운데 선 위, 매수 3단은 아래 행에 놓이고 나머지 행은 비어 있다", () => {
  const rows = auction();
  expect(rows).toHaveLength(LADDER_ROWS);
  expect(prices(rows).slice(7, 13)).toEqual([821_000, 820_000, 819_000, 818_000, 817_000, 816_000]);
  expect([...prices(rows).slice(0, 7), ...prices(rows).slice(13)].every((price) => price === null)).toBe(true);
  expect(rows.slice(7, 10).map((row) => [row.ask?.quantity, row.bid])).toEqual([[418, null], [1_533, null], [934, null]]);
  expect(rows.slice(10, 13).map((row) => [row.ask, row.bid?.quantity])).toEqual([[null, 3_012], [null, 61], [null, 57]]);
});

test("동시호가 캡처: 정보 일곱 칸과 예상체결 두 칸이 하나도 가려지지 않는다", () => {
  const info = quoteInfoItems({ price: 810_000, previousClose: 810_000, volume: 0, upperLimit: 1_053_000, lowerLimit: 567_000 });
  const slots = placeInfoItems(auction(), info, expectedInfoItems({ price: 819_000, qty: 100 }, 810_000));
  expect(slots.filter((slot) => slot !== null).map((slot) => slot!.label)).toEqual([...info.map((item) => item.label), "예상체결가", "예상체결량"]);
});

test("교차 호가(매도 1호가 70,000, 매수 1호가 70,100)도 매도는 선 위, 매수는 선 아래이고 행 키가 겹치지 않는다", () => {
  const rows = auction({ asks: [level(70_000, 5), level(70_100, 6), level(70_200, 7)], bids: [level(70_100, 8), level(70_000, 9), level(69_900, 10)], lastPrice: 70_000, previousClose: 70_000, bounds: NO_BOUNDS });
  expect(prices(rows).slice(7, 13)).toEqual([70_200, 70_100, 70_000, 70_100, 70_000, 69_900]);
  expect(rows.slice(7, 10).map((row) => [row.ask?.quantity, row.bid])).toEqual([[7, null], [6, null], [5, null]]);
  expect(rows.slice(10, 13).map((row) => [row.ask, row.bid?.quantity])).toEqual([[null, 8], [null, 9], [null, 10]]);
  expect(new Set(rows.map((row) => row.key)).size).toBe(LADDER_ROWS);
});

test("한쪽만 있는 호가(매도 0단·매수 2단)도 단일가 호가이고 매수가 선 아래에 놓인다", () => {
  const quotes = { asks: [], bids: [level(70_000, 5), level(69_900, 6)], lastPrice: 70_000, previousClose: 70_000 };
  expect(isSinglePriceBook(quotes)).toBe(true);
  const rows = auction({ ...quotes, bounds: NO_BOUNDS });
  expect(prices(rows).slice(9, 13)).toEqual([null, 70_000, 69_900, null]);
  expect(rows.filter((row) => row.price !== null && row.bid)).toHaveLength(2);
});

test("호가가 아예 없으면 단일가 호가가 아니고 기존 격자 규칙을 따른다", () => {
  expect(isSinglePriceBook({ asks: [], bids: [], lastPrice: 70_000, previousClose: null })).toBe(false);
  expect(prices(auction({ asks: [], bids: [], lastPrice: 70_000, bounds: NO_BOUNDS }))).toEqual(prices(build({ lastPrice: 70_000 })));
});

test("가격 없는 단은 단으로 세지 않는다", () => {
  const asks = [level(70_100, 1), level(0, 0), level(Number.NaN, 0), level(70_200, 1), level(70_300, 1), level(70_400, 1)];
  expect(isSinglePriceBook({ asks: asks.slice(0, 3), bids: [], lastPrice: 70_000, previousClose: null })).toBe(true);
  expect(isSinglePriceBook({ asks, bids: [], lastPrice: 70_000, previousClose: null })).toBe(false);
});

test("10단 호가(매도 4단 이상 또는 매수 4단 이상)도 매도 1호가가 가운데 선 바로 위 행이다", () => {
  const four = [level(70_100, 1), level(70_200, 2), level(70_300, 3), level(70_400, 4)];
  const threeBids = [level(70_000, 5), level(69_900, 6), level(69_800, 7)];
  const input = { asks: four, bids: threeBids, lastPrice: 70_000, previousClose: 69_000 };
  expect(isSinglePriceBook(input)).toBe(false);
  expect(auction({ ...input, bounds: NO_BOUNDS })).toEqual(build(input));
  expect(defaultLadderPrices({ ...input, bounds: NO_BOUNDS, tickRule: "stock" }).sidesSplit).toBe(false);
  const full = { asks: Array.from({ length: 10 }, (_, i) => level(70_100 + 100 * i, 10)), bids: Array.from({ length: 10 }, (_, i) => level(70_000 - 100 * i, 10)), lastPrice: 70_000, previousClose: 69_000 };
  expect(auction({ ...full, bounds: NO_BOUNDS })).toEqual(build(full));
});

const CAPTURE_TEN_ASKS = Array.from({ length: 10 }, (_, i) => level(196_400 + 100 * i, 100 + i));
const CAPTURE_TEN_BIDS = Array.from({ length: 10 }, (_, i) => level(196_300 - 100 * i, 200 + i));
const captured = (input: Partial<Parameters<typeof buildDefaultLadder>[0]> = {}) => auction({ asks: CAPTURE_TEN_ASKS, bids: CAPTURE_TEN_BIDS, lastPrice: 196_400, previousClose: 195_000, bounds: NO_BOUNDS, ...input });

test("매도 1호가가 현재가와 같아도 매도 10단은 가운데 선 위, 매수 10단은 아래 행에 든다", () => {
  const rows = captured();
  expect(prices(rows)[0]).toBe(197_300);
  expect(prices(rows)[9]).toBe(196_400);
  expect(prices(rows)[10]).toBe(196_300);
  expect(prices(rows)[19]).toBe(195_400);
  expect(rows.slice(0, 10).every((row) => row.ask !== null && row.bid === null)).toBe(true);
  expect(rows.slice(10).every((row) => row.bid !== null && row.ask === null)).toBe(true);
  expect(rows.filter((row) => row.current).map((row) => row.price)).toEqual([196_400]);
});

test("현재가가 매수 1호가면 행 배치가 지금과 같다", () => {
  const rows = captured({ lastPrice: 196_300 });
  expect(prices(rows)).toEqual(prices(build({ lastPrice: 196_300 })));
  expect(rows.filter((row) => row.current).map((row) => row.price)).toEqual([196_300]);
});

test("호가 사이가 벌어지면 빈 가격 행을 두고 매수 단이 그만큼 아래로 밀린다", () => {
  const rows = captured({ bids: CAPTURE_TEN_BIDS.map((l) => level(l.price - 200, l.quantity)) });
  expect(prices(rows)[9]).toBe(196_400);
  expect(prices(rows)[10]).toBe(196_300);
  expect([rows[10]!.bid, rows[11]!.bid]).toEqual([null, null]);
  expect(rows[12]!.bid?.price).toBe(196_100);
  expect(prices(rows)[19]).toBe(195_400);
  expect(rows.filter((row) => row.bid)).toHaveLength(8);
});

test("매도 호가가 없으면 매수 1호가를 가운데 선 바로 아래 행에 둔다", () => {
  const rows = captured({ asks: [], lastPrice: 196_300 });
  expect(prices(rows)[10]).toBe(196_300);
  expect(prices(rows)[0]).toBe(197_300);
  expect(prices(rows)[19]).toBe(195_400);
  expect(rows[10]!.bid?.price).toBe(196_300);
});

test("호가가 하나도 없으면 현재가, 없으면 전일종가를 가운데 선 바로 아래 행에 둔다", () => {
  expect(prices(captured({ asks: [], bids: [], lastPrice: 196_000 }))[10]).toBe(196_000);
  expect(prices(captured({ asks: [], bids: [], lastPrice: null, previousClose: 195_000 }))[10]).toBe(195_000);
  expect(prices(captured({ asks: [], bids: [], lastPrice: null, previousClose: null })).every((price) => price === null)).toBe(true);
});

test("교차 호가는 매도 1호가를 기준으로 그리고 같은 가격 행에 양쪽 잔량을 붙인다", () => {
  const asks = Array.from({ length: 10 }, (_, i) => level(196_400 + 100 * i, 100 + i));
  const bids = Array.from({ length: 10 }, (_, i) => level(196_500 - 100 * i, 200 + i));
  const rows = captured({ asks, bids, lastPrice: 196_500 });
  expect(prices(rows)[9]).toBe(196_400);
  expect(prices(rows)[8]).toBe(196_500);
  expect([rows[9]!.ask?.quantity, rows[9]!.bid?.quantity]).toEqual([100, 201]);
  expect([rows[8]!.ask?.quantity, rows[8]!.bid?.quantity]).toEqual([101, 200]);
  expect(rows.filter((row) => row.current).map((row) => row.price)).toEqual([196_500]);
});

test("상·하한가 밖 행은 비운다", () => {
  const nearUpper = captured({ bounds: { lower: 150_000, upper: 196_800 } });
  expect(prices(nearUpper).slice(0, 10)).toEqual([null, null, null, null, null, 196_800, 196_700, 196_600, 196_500, 196_400]);
  const nearLower = captured({ bounds: { lower: 195_900, upper: 250_000 } });
  expect(prices(nearLower).slice(10)).toEqual([196_300, 196_200, 196_100, 196_000, 195_900, null, null, null, null, null]);
});

const skipGap = (input: Partial<Parameters<typeof buildDefaultLadder>[0]> = {}) => captured({ skipSpreadGap: true, ...input });
const WIDE_BIDS = CAPTURE_TEN_BIDS.map((l) => level(l.price - 200, l.quantity));

test("호가 사이 빈 가격 건너뛰기를 켜면 벌어진 호가에서 매수 1호가가 가운데 선 바로 아래 행에 온다", () => {
  const rows = skipGap({ bids: WIDE_BIDS });
  expect(prices(rows)[9]).toBe(196_400);
  expect(prices(rows)[10]).toBe(196_100);
  expect(prices(rows)[19]).toBe(195_200);
  expect(rows.slice(10).every((row) => row.bid !== null)).toBe(true);
  expect(rows.slice(0, 10).every((row) => row.ask !== null)).toBe(true);
});

test("호가 사이 빈 가격 건너뛰기를 켜도 붙은 호가·교차 호가·한쪽 호가 없음은 꺼짐과 같다", () => {
  const crossed = { bids: Array.from({ length: 10 }, (_, i) => level(196_500 - 100 * i, 200 + i)), lastPrice: 196_500 };
  const cases = [{}, crossed, { asks: [], lastPrice: 196_300 }, { bids: [] }];
  for (const input of cases) expect(skipGap(input)).toEqual(captured(input));
  expect(skipGap({ bids: WIDE_BIDS })).not.toEqual(captured({ bids: WIDE_BIDS }));
});

test("호가 사이 빈 가격 건너뛰기를 켜도 단일가 호가는 그대로다", () => {
  expect(skipGap({ asks: CAPTURE_ASKS, bids: CAPTURE_BIDS })).toEqual(captured({ asks: CAPTURE_ASKS, bids: CAPTURE_BIDS }));
});

test("예상체결가가 6호가 가격이면 그 행 가격이 목록에 있어 같은 가격으로 찾을 수 있다", () => {
  const rows = auction();
  expect(rows.filter((row) => row.price === 819_000)).toHaveLength(1);
  expect(rows.findIndex((row) => row.price === 819_000)).toBe(9);
});

test("단일가 행의 가격 목록을 붙잡고 새 호가로 다시 그리면 가격은 그대로이고 잔량만 바뀐다", () => {
  const held = defaultLadderPrices({ asks: CAPTURE_ASKS, bids: CAPTURE_BIDS, lastPrice: 810_000, previousClose: 810_000, bounds: NO_BOUNDS, tickRule: "stock" });
  const next = { asks: [level(821_000, 1), level(820_000, 2), level(819_500, 3)], bids: [level(818_000, 4), level(817_500, 5)], lastPrice: 810_000, previousClose: 810_000 };
  const rows = buildLadderRows(held.prices, next, held.sidesSplit);
  expect(prices(rows)).toEqual(held.prices);
  expect(rows.slice(7, 10).map((row) => row.ask?.quantity ?? null)).toEqual([1, 2, null]);
  expect(rows.slice(10, 13).map((row) => row.bid?.quantity ?? null)).toEqual([4, null, null]);
});

test("교차 단일가 호가에서 같은 가격이 두 행에 있으면 현재가 표시는 첫 행에만 붙고 뒤 행은 반복으로 표시된다", () => {
  const rows = auction({ asks: [level(70_000, 5), level(70_100, 6), level(70_200, 7)], bids: [level(70_100, 8), level(70_000, 9), level(69_900, 10)], lastPrice: 70_100, previousClose: 70_000, bounds: NO_BOUNDS });
  expect(rows.filter((row) => row.current).map((row) => rows.indexOf(row))).toEqual([8]);
  expect(rows.map((row, index) => [index, row.repeat]).filter(([, repeat]) => repeat)).toEqual([[10, true], [11, true]]);
  expect(buildLadder({ asks: [], bids: [], lastPrice: 70_000, previousClose: null, bounds: NO_BOUNDS, tickRule: "stock" }).some((row) => row.repeat)).toBe(false);
});
