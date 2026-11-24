import { expect, test } from "vitest";
import type { FeedTrade } from "../../api/generated/FeedTrade";
import type { TradeTape } from "../../api/generated/TradeTape";
import type { Venue } from "../../api/generated/Venue";
import { cumulativeQuantity, emptyTape, MAX_TAPE_ROWS, minAmountWon, recentBuySell, tapeReducer, visibleEntries, type TapeAction } from "./tape";

const DAY = Date.UTC(2026, 10, 9) / 1000 - 9 * 3600;
const at = (hhmmss: string): number => {
  const [h, m, s] = hhmmss.split(":").map(Number);
  return DAY + h! * 3600 + m! * 60 + s!;
};

const print = (time: string, price: number, quantity: number, exchange: Venue | null = "krx") => ({ time, price, quantity, exchange });
const tapeOf = (trades: TradeTape["trades"], venue: Venue = "combined"): TradeTape => ({ symbol: "005930", venue, trades, skippedRows: 0 });
const live = (t: string, price: number, qty: number, venue: Venue | null = "krx", strength: number | null = null, sameTimeRatio?: number): FeedTrade => ({ t: at(t), price, qty, venue, strength, ...(sameTimeRatio === undefined ? {} : { sameTimeRatio }) });
const run = (...actions: TapeAction[]) => actions.reduce(tapeReducer, emptyTape);
const times = (state: ReturnType<typeof run>, venue: Venue = "combined", minWon = 0) =>
  visibleEntries(state, venue, minWon).entries.flatMap((e) => (e.kind === "trade" ? [`${e.origin[0]}${e.price}`] : ["gap"]));

test("조회와 실시간이 겹치면 첫 실시간 체결 시각 이상인 조회 행은 버리고 실시간만 남긴다", () => {
  const history = tapeOf([print("10:00:03", 103, 1), print("10:00:02", 102, 1), print("10:00:01", 101, 1)]);
  const afterLive = run({ type: "history", tape: history }, { type: "live", trades: [live("10:00:02", 202, 5)], receivedAt: 0 });
  expect(times(afterLive)).toEqual(["l202", "h101"]);
  const liveFirst = run({ type: "live", trades: [live("10:00:02", 202, 5)], receivedAt: 0 }, { type: "history", tape: history });
  expect(times(liveFirst)).toEqual(["l202", "h101"]);
});

test("조회가 두 번 들어오면 뒤의 것으로 바뀌고 실시간 행과 겹치지 않는다", () => {
  const firstPage = tapeOf([print("10:00:03", 103, 1)]);
  const full = tapeOf([print("10:00:03", 103, 1), print("10:00:02", 102, 1), print("10:00:01", 101, 1)]);
  expect(times(run({ type: "history", tape: firstPage }, { type: "history", tape: full }))).toEqual(["h103", "h102", "h101"]);
  const withLive = run({ type: "live", trades: [live("10:00:02", 202, 5)], receivedAt: 0 }, { type: "history", tape: firstPage }, { type: "history", tape: full });
  expect(times(withLive)).toEqual(["l202", "h101"]);
});

test("500줄을 넘으면 오래된 줄부터 버린다", () => {
  const frames: TapeAction[] = Array.from({ length: MAX_TAPE_ROWS + 20 }, (_, i) => ({ type: "live", trades: [live("10:00:00", 1000 + i, 1)], receivedAt: 0 }));
  const entries = visibleEntries(run(...frames), "combined", 0).entries;
  expect(entries).toHaveLength(MAX_TAPE_ROWS);
  expect(entries[0]).toMatchObject({ price: 1000 + MAX_TAPE_ROWS + 19 });
  expect(entries.at(-1)).toMatchObject({ price: 1020 });
  const history = tapeOf(Array.from({ length: MAX_TAPE_ROWS }, (_, i) => print("09:00:00", 500 + i, 1)));
  expect(visibleEntries(run({ type: "history", tape: history }, { type: "live", trades: [live("10:00:00", 9, 1)], receivedAt: 0 }), "combined", 0).entries).toHaveLength(MAX_TAPE_ROWS);
});

test("최소 금액 필터는 가격×수량 기준이다", () => {
  const state = run({ type: "live", trades: [live("10:00:00", 70_000, 400), live("10:00:01", 70_000, 500), live("10:00:02", 1_000, 100_000)], receivedAt: 0 });
  expect(times(state, "combined", minAmountWon("30m"))).toEqual(["l1000", "l70000"]);
  expect(times(state, "combined", minAmountWon("100m"))).toEqual(["l1000"]);
  expect(times(state, "combined", minAmountWon("all"))).toHaveLength(3);
});

test("KRX를 고르면 NXT 실시간 체결과 거래소를 모르는 실시간 체결은 보이지 않는다", () => {
  const state = run({ type: "live", trades: [live("10:00:00", 1, 1, "krx"), live("10:00:01", 2, 1, "nxt"), live("10:00:02", 3, 1, null)], receivedAt: 0 });
  expect(times(state, "krx")).toEqual(["l1"]);
  expect(times(state, "nxt")).toEqual(["l2"]);
});

test("멈춘 동안 새 체결은 대기하고 풀면 맨 위에 이어 붙는다", () => {
  const held = run({ type: "live", trades: [live("10:00:00", 1, 1)], receivedAt: 0 }, { type: "hold" }, { type: "live", trades: [live("10:00:01", 2, 1), live("10:00:02", 3, 1)], receivedAt: 0 });
  expect(times(held)).toEqual(["l1"]);
  expect(held.pending).toHaveLength(2);
  const released = tapeReducer(held, { type: "release" });
  expect(times(released)).toEqual(["l3", "l2", "l1"]);
  expect(released.holding).toBe(false);
  expect(released.pending).toHaveLength(0);
});

test("멈춘 동안에는 겹친 조회 행도 그대로 두었다가 풀면 정리한다", () => {
  const history = tapeOf([print("10:00:03", 103, 1), print("10:00:01", 101, 1)]);
  const held = run({ type: "history", tape: history }, { type: "hold" }, { type: "live", trades: [live("10:00:02", 202, 5)], receivedAt: 0 });
  expect(times(held)).toEqual(["h103", "h101"]);
  const released = tapeReducer(held, { type: "release" });
  expect(times(released)).toEqual(["l202", "h101"]);
  expect(released.holding).toBe(false);
});

test("끊김은 구분 줄 하나로 보이고 이어지면 같은 줄이 닫힌다", () => {
  const state = run({ type: "live", trades: [live("10:00:00", 1, 1)], receivedAt: 0 }, { type: "link", live: false, at: at("10:00:05") }, { type: "link", live: false, at: at("10:00:06") });
  expect(times(state)).toEqual(["gap", "l1"]);
  const closed = tapeReducer(state, { type: "link", live: true, at: at("10:00:20") });
  expect(visibleEntries(closed, "combined", 0).entries[0]).toMatchObject({ kind: "gap", fromSecond: 36005, toSecond: 36020 });
  expect(times(tapeReducer(closed, { type: "link", live: true, at: at("10:00:21") }))).toEqual(["gap", "l1"]);
  expect(times(run({ type: "resync", at: at("10:01:00") }))).toEqual(["gap"]);
});

test("체결강도는 가장 최근에 받은 값이고 없으면 비어 있다", () => {
  expect(run({ type: "live", trades: [live("10:00:00", 1, 1)], receivedAt: 0 }).strength).toBeNull();
  const state = run({ type: "live", trades: [live("10:00:00", 1, 1, "krx", 101.5), live("10:00:01", 1, 1, "krx", 102.25), live("10:00:02", 1, 1, "krx", null)], receivedAt: 0 });
  expect(state.strength).toBe(102.25);
});

test("동시간비는 가장 최근에 받은 값을 유지하고 초기화하면 사라진다", () => {
  expect(run({ type: "live", trades: [live("10:00:00", 1, 1)], receivedAt: 0 }).sameTimeRatio).toBeNull();
  const state = run(
    { type: "live", trades: [live("10:00:00", 1, 1, "krx", null, 93.95), live("10:00:01", 1, 1, "krx", null, 95.5), live("10:00:02", 1, 1, "krx", null)], receivedAt: 0 },
    { type: "live", trades: [live("10:00:03", 1, 1, "krx", null)], receivedAt: 0 },
  );
  expect(state.sameTimeRatio).toBe(95.5);
  expect(tapeReducer(state, { type: "reset" }).sameTimeRatio).toBeNull();
});

test("수량의 부호가 방향이고 누적은 줄 수 상한과 무관하다", () => {
  const state = run({ type: "history", tape: tapeOf([print("09:59:00", 100, -4)]) }, { type: "live", trades: [live("10:00:00", 100, 3)], receivedAt: 0 });
  const entries = visibleEntries(state, "combined", 0).entries;
  expect(entries.map((e) => (e.kind === "trade" ? [e.side, e.quantity] : []))).toEqual([["buy", 3], ["sell", 4]]);
  expect(recentBuySell(entries)).toEqual({ buy: 3, sell: 4 });
  expect(cumulativeQuantity(state, "combined")).toBe(7);
  const many = run(...Array.from({ length: MAX_TAPE_ROWS + 10 }, (_, i): TapeAction => ({ type: "live", trades: [live("10:00:00", 100, 1 + (i % 2))], receivedAt: 0 })));
  expect(cumulativeQuantity(many, "combined")).toBe(Math.ceil((MAX_TAPE_ROWS + 10) / 2) * 1 + Math.floor((MAX_TAPE_ROWS + 10) / 2) * 2);
});

test("초기화하면 앞 거래소의 조회·실시간 체결과 체결강도가 사라진다", () => {
  const filled = run({ type: "history", tape: tapeOf([print("10:00:01", 101, 1)]) }, { type: "live", trades: [live("10:00:02", 202, 5, "nxt", 150)], receivedAt: 0 });
  expect(filled.strength).toBe(150);
  const reset = tapeReducer(filled, { type: "reset" });
  expect(reset.strength).toBeNull();
  expect(reset.historyVenue).toBeNull();
  expect(times(reset, "krx")).toEqual([]);
});
