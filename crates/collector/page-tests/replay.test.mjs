import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFrame, formatClock, parseClock } from "../page/replay.js";

const columns = (values) => Object.fromEntries(Object.entries(values).map(([name, list]) => [name, Int32Array.from(list)]));

const tradeSpan = (key, recv, price) => ({
  key,
  span: {
    streams: {
      trades: {
        rows: recv.length,
        columns: columns({ recv_ms: recv, t_s: recv.map((value) => Math.floor(value / 1000)), price, qty: recv.map((_, i) => (i % 2 ? -3 : 5)), venue: recv.map(() => 1) }),
      },
    },
  },
});

test("시각 문자열을 오가며 읽는다", () => {
  assert.equal(parseClock("19:58:00.000"), 71_880_000);
  assert.equal(parseClock("20:00"), 72_000_000);
  assert.equal(parseClock("10:30:30.5"), 37_830_500);
  assert.equal(parseClock("25:00:00"), null);
  assert.equal(parseClock("abc"), null);
  assert.equal(parseClock(null), null);
  assert.equal(formatClock(71_880_000), "19:58:00.000");
  assert.equal(formatClock(37_830_007), "10:30:30.007");
});

test("최근 체결은 커서 시각까지 최신 순이고 앞 구간으로 이어진다", () => {
  const earlier = tradeSpan("a", [1000, 2000], [10, 11]);
  const current = tradeSpan("b", [5000, 6000, 7000], [20, 21, 22]);
  const frame = buildFrame({ current, earlier: [earlier], timeMs: 6500, members: {} });
  assert.deepEqual(frame.trades.value.map((trade) => trade.price), [21, 20, 11, 10]);
  assert.equal(frame.trades.value[0].side, "sell");
  assert.equal(frame.trades.value[0].qty, 3);
});

test("체결은 20건까지만 보인다", () => {
  const recv = Array.from({ length: 30 }, (_, i) => i * 10);
  const current = tradeSpan("c", recv, recv);
  const frame = buildFrame({ current, timeMs: 1000, members: {} });
  assert.equal(frame.trades.value.length, 20);
  assert.equal(frame.trades.value[0].price, 290);
});

test("행이 없는 흐름은 빈 값이다", () => {
  const frame = buildFrame({ current: { key: "d", span: { streams: {} } }, timeMs: 0, members: {} });
  assert.equal(frame.book.value, null);
  assert.equal(frame.program.value, null);
  assert.equal(frame.broker.value, null);
  assert.deepEqual(frame.trades.value, []);
  assert.equal(frame.inGap, false);
});

test("프로그램 순매수는 매수에서 매도를 뺀다", () => {
  const current = {
    key: "e",
    span: { streams: { program: { rows: 1, columns: columns({ recv_ms: [0], t_s: [0], sell_qty: [30], sell_amt: [4], buy_qty: [100], buy_amt: [9] }) } } },
  };
  const frame = buildFrame({ current, timeMs: 10, members: {} });
  assert.equal(frame.program.value.netQty, 70);
  assert.equal(frame.program.value.netAmt, 5);
});

test("수집 끊김 안의 시각을 알아낸다", () => {
  const current = { key: "f", span: { streams: { gaps: { rows: 1, columns: columns({ from_ms: [100], to_ms: [200] }) } } } };
  assert.equal(buildFrame({ current, timeMs: 99, members: {} }).inGap, false);
  assert.equal(buildFrame({ current, timeMs: 100, members: {} }).inGap, true);
  assert.equal(buildFrame({ current, timeMs: 200, members: {} }).inGap, false);
});
