import { expect, test } from "vitest";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import { newestFirst } from "./accountLists";

const fill = (orderNo: string, time: string): TradingExecution => ({ orderNo, code: "005930", name: "삼성전자", side: "buy", quantity: 1, price: 70_000, time, venue: "krx" });
const orderNos = (fills: readonly TradingExecution[]) => fills.map((f) => f.orderNo);

test("체결은 시각 내림차순이다", () => {
  expect(orderNos(newestFirst([fill("1", "090000"), fill("2", "153000"), fill("3", "101500")]))).toEqual(["2", "3", "1"]);
});

test("콜론이 있는 HH:MM:SS 시각도 최신순으로 정렬한다", () => {
  expect(orderNos(newestFirst([fill("1", "09:00:00"), fill("2", "15:30:00"), fill("3", "10:15:00")]))).toEqual(["2", "3", "1"]);
  expect(orderNos(newestFirst([fill("0000002", "10:00:00"), fill("0000010", "100000"), fill("0000005", "10:00:00")]))).toEqual(["0000010", "0000005", "0000002"]);
});

test("같은 초는 주문번호가 큰 쪽이 위다", () => {
  expect(orderNos(newestFirst([fill("0000002", "100000"), fill("0000010", "100000"), fill("0000005", "100000")]))).toEqual(["0000010", "0000005", "0000002"]);
});

test("시·분·초가 아닌 시각은 맨 아래에 받은 순서대로 둔다", () => {
  expect(orderNos(newestFirst([fill("a", ""), fill("1", "09:00:00"), fill("b", "9:30"), fill("2", "100000")]))).toEqual(["2", "1", "a", "b"]);
});

test("받은 목록은 바꾸지 않는다", () => {
  const received = [fill("1", "090000"), fill("2", "100000")];
  newestFirst(received);
  expect(orderNos(received)).toEqual(["1", "2"]);
});
