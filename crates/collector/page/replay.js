import { lastRowAtOrBefore } from "./seek.js";

export const BOOK_LEVELS = 10;
export const RECENT_TRADE_LIMIT = 20;
export const BROKER_RANKS = 5;
const VENUE_NAMES = { 1: "KRX", 2: "NXT" };

const pad = (value, width = 2) => String(value).padStart(width, "0");

export function formatClock(msOfDay) {
  const whole = Math.max(0, Math.floor(msOfDay));
  const hours = Math.floor(whole / 3_600_000);
  const minutes = Math.floor(whole / 60_000) % 60;
  const seconds = Math.floor(whole / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(whole % 1000, 3)}`;
}

export function formatSecondOfDay(seconds) {
  return formatClock(seconds * 1000).slice(0, 8);
}

export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text ?? "");
  if (!match) return null;
  const [, hours, minutes, seconds = "0", fraction = "0"] = match;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

export function memberName(members, code) {
  return members?.[pad(code, 3)] ?? pad(code, 3);
}

function bookSection(current, timeMs) {
  const book = current.span.streams.book;
  const row = book ? lastRowAtOrBefore(book.columns.recv_ms, timeMs) : -1;
  const key = `${current.key}#book${row}`;
  if (row < 0) return { key, value: null };
  const columns = book.columns;
  const level = (side, number) => ({
    level: number,
    price: columns[`${side}_px${number}`][row],
    qty: columns[`${side}_qty${number}`][row],
  });
  const range = Array.from({ length: BOOK_LEVELS }, (_, index) => index + 1);
  const asks = range.map((number) => level("ask", number));
  const bids = range.map((number) => level("bid", number));
  const crossed = asks[0].price > 0 && bids[0].price > 0 && bids[0].price >= asks[0].price;
  return {
    key,
    value: { asks, bids, askTotal: columns.ask_total[row], bidTotal: columns.bid_total[row], crossed },
  };
}

function programSection(current, timeMs) {
  const program = current.span.streams.program;
  const row = program ? lastRowAtOrBefore(program.columns.recv_ms, timeMs) : -1;
  const key = `${current.key}#program${row}`;
  if (row < 0) return { key, value: null };
  const columns = program.columns;
  const buyQty = columns.buy_qty[row];
  const sellQty = columns.sell_qty[row];
  const buyAmt = columns.buy_amt[row];
  const sellAmt = columns.sell_amt[row];
  return { key, value: { buyQty, sellQty, buyAmt, sellAmt, netQty: buyQty - sellQty, netAmt: buyAmt - sellAmt } };
}

function brokerSection(current, timeMs, members) {
  const broker = current.span.streams.broker;
  const row = broker ? lastRowAtOrBefore(broker.columns.recv_ms, timeMs) : -1;
  const key = `${current.key}#broker${row}`;
  if (row < 0) return { key, value: null };
  const columns = broker.columns;
  const side = (prefix) =>
    Array.from({ length: BROKER_RANKS }, (_, index) => {
      const code = columns[`${prefix}_code${index + 1}`][row];
      const qty = columns[`${prefix}_qty${index + 1}`][row];
      return { rank: index + 1, code, name: code === 0 ? null : memberName(members, code), qty };
    });
  return { key, value: { sell: side("sell"), buy: side("buy") } };
}

function tradeSection(current, earlier, timeMs) {
  const trades = [];
  const earlierUsed = [];
  const currentStream = current.span.streams.trades;
  const currentRow = currentStream ? lastRowAtOrBefore(currentStream.columns.recv_ms, timeMs) : -1;
  const take = (stream, firstRow) => {
    const columns = stream.columns;
    for (let row = firstRow; row >= 0 && trades.length < RECENT_TRADE_LIMIT; row--) {
      const signedQty = columns.qty[row];
      trades.push({
        timeSecond: columns.t_s[row],
        price: columns.price[row],
        qty: Math.abs(signedQty),
        side: signedQty > 0 ? "buy" : "sell",
        venue: VENUE_NAMES[columns.venue[row]] ?? null,
      });
    }
  };
  if (currentStream) take(currentStream, currentRow);
  for (const { key, span } of earlier) {
    if (trades.length >= RECENT_TRADE_LIMIT) break;
    const stream = span.streams.trades;
    if (!stream || stream.rows === 0) continue;
    earlierUsed.push(key);
    take(stream, stream.rows - 1);
  }
  return { key: `${current.key}#trades${currentRow}@${earlierUsed.join(",")}`, value: trades };
}

function gapContains(current, timeMs) {
  const gaps = current.span.streams.gaps;
  if (!gaps) return false;
  const { from_ms: from, to_ms: to } = gaps.columns;
  for (let row = 0; row < gaps.rows; row++) {
    if (from[row] <= timeMs && timeMs < to[row]) return true;
  }
  return false;
}

export function buildFrame({ current, earlier = [], timeMs, members }) {
  return {
    timeMs,
    inGap: gapContains(current, timeMs),
    book: bookSection(current, timeMs),
    trades: tradeSection(current, earlier, timeMs),
    program: programSection(current, timeMs),
    broker: brokerSection(current, timeMs, members),
  };
}

export function emptyFrame(timeMs) {
  const none = (key) => ({ key, value: null });
  return {
    timeMs,
    inGap: false,
    book: none("none#book"),
    trades: { key: "none#trades", value: [] },
    program: none("none#program"),
    broker: none("none#broker"),
  };
}
