import { BOOK_LEVELS, BROKER_RANKS, RECENT_TRADE_LIMIT, formatSecondOfDay } from "./replay.js";

const DASH = "—";
const SIDE_NAMES = { buy: "매수", sell: "매도" };
const numberFormat = new Intl.NumberFormat("ko-KR");

const format = (value) => numberFormat.format(value);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setData(node, values) {
  for (const [name, value] of Object.entries(values)) {
    const text = value === null || value === undefined ? "" : String(value);
    if (node.dataset[name] !== text) node.dataset[name] = text;
  }
}

function labelledValue(parent, id, label) {
  const row = element("div", "line");
  const value = element("span", "value", DASH);
  value.id = id;
  row.append(element("span", "label", label), value);
  parent.append(row);
  return value;
}

function buildBook(root) {
  const askTotal = element("div", "total");
  const askTotalValue = element("span", "value", DASH);
  askTotalValue.id = "book-ask-total";
  askTotal.append(element("span", "label", "매도 총잔량"), askTotalValue);
  const bidTotal = element("div", "total");
  const bidTotalValue = element("span", "value", DASH);
  bidTotalValue.id = "book-bid-total";
  bidTotal.append(element("span", "label", "매수 총잔량"), bidTotalValue);

  const rows = [];
  const levels = Array.from({ length: BOOK_LEVELS }, (_, index) => index + 1);
  const sides = [
    ...levels.slice().reverse().map((level) => ["ask", level]),
    ...levels.map((level) => ["bid", level]),
  ];
  const list = element("div", "book-rows");
  for (const [side, level] of sides) {
    const row = element("div", `book-row ${side}`);
    row.dataset.bookRow = "";
    row.dataset.side = side;
    row.dataset.level = String(level);
    const price = element("span", "price", DASH);
    const qty = element("span", "qty", DASH);
    row.append(element("span", "level", `${SIDE_NAMES[side === "ask" ? "sell" : "buy"]}${level}`), price, qty);
    list.append(row);
    rows.push({ row, price, qty, side, level });
  }
  const cross = element("span", "cross", "교차");
  cross.id = "book-cross";
  const gap = element("div", "gap-banner", "수집 끊김");
  gap.id = "gap-banner";
  root.append(gap, askTotal, list, bidTotal, cross);
  return { rows, askTotalValue, bidTotalValue, cross, gap };
}

function buildTrades(root) {
  const header = element("div", "trade-row head");
  for (const text of ["시각", "가격", "수량", "구분", "거래소"]) header.append(element("span", "", text));
  root.append(header);
  const rows = [];
  for (let index = 0; index < RECENT_TRADE_LIMIT; index++) {
    const row = element("div", "trade-row");
    row.dataset.tradeRow = "";
    const cells = ["time", "price", "qty", "side", "venue"].map((name) => element("span", name, ""));
    row.append(...cells);
    root.append(row);
    rows.push({ row, cells });
  }
  return rows;
}

function buildProgram(root) {
  return {
    netQty: labelledValue(root, "program-net-qty", "순매수 수량"),
    netAmt: labelledValue(root, "program-net-amt", "순매수 금액(백만원)"),
    buyQty: labelledValue(root, "program-buy-qty", "누적 매수 수량"),
    buyAmt: labelledValue(root, "program-buy-amt", "누적 매수 금액(백만원)"),
    sellQty: labelledValue(root, "program-sell-qty", "누적 매도 수량"),
    sellAmt: labelledValue(root, "program-sell-amt", "누적 매도 금액(백만원)"),
  };
}

function buildBrokers(root) {
  const rows = { sell: [], buy: [] };
  for (const side of ["sell", "buy"]) {
    const column = element("div", `broker-column ${side}`);
    column.append(element("div", "broker-title", `${SIDE_NAMES[side]} 상위 5`));
    for (let rank = 1; rank <= BROKER_RANKS; rank++) {
      const row = element("div", "broker-row");
      row.dataset.brokerRow = "";
      row.dataset.side = side;
      row.dataset.rank = String(rank);
      const name = element("span", "name", DASH);
      const qty = element("span", "qty", DASH);
      row.append(name, qty);
      column.append(row);
      rows[side].push({ row, name, qty });
    }
    root.append(column);
  }
  return rows;
}

export function createView() {
  const book = buildBook(document.getElementById("book"));
  const tradeRows = buildTrades(document.getElementById("trades"));
  const program = buildProgram(document.getElementById("program"));
  const brokers = buildBrokers(document.getElementById("brokers"));
  const drawn = { book: null, trades: null, program: null, broker: null, gap: null };

  function drawBook(section) {
    const value = section.value;
    setText(book.askTotalValue, value ? format(value.askTotal) : DASH);
    setText(book.bidTotalValue, value ? format(value.bidTotal) : DASH);
    setData(book.askTotalValue, { value: value?.askTotal });
    setData(book.bidTotalValue, { value: value?.bidTotal });
    book.cross.dataset.on = value?.crossed ? "true" : "false";
    for (const line of book.rows) {
      const cell = value ? (line.side === "ask" ? value.asks : value.bids)[line.level - 1] : null;
      setText(line.price, cell ? format(cell.price) : DASH);
      setText(line.qty, cell ? format(cell.qty) : DASH);
      setData(line.row, { price: cell?.price, qty: cell?.qty });
    }
  }

  function drawTrades(section) {
    tradeRows.forEach(({ row, cells }, index) => {
      const trade = section.value[index];
      setText(cells[0], trade ? formatSecondOfDay(trade.timeSecond) : "");
      setText(cells[1], trade ? format(trade.price) : "");
      setText(cells[2], trade ? format(trade.qty) : "");
      setText(cells[3], trade ? SIDE_NAMES[trade.side] : "");
      setText(cells[4], trade ? (trade.venue ?? DASH) : "");
      setData(row, {
        time: trade ? formatSecondOfDay(trade.timeSecond) : null,
        price: trade?.price,
        qty: trade?.qty,
        side: trade?.side,
        venue: trade ? (trade.venue ?? "") : null,
      });
      row.dataset.side = trade ? trade.side : "";
    });
    const placeholder = section.value.length === 0;
    tradeRows[0].cells[0].dataset.empty = String(placeholder);
    if (placeholder) setText(tradeRows[0].cells[0], DASH);
  }

  function drawProgram(section) {
    const value = section.value;
    const cells = [
      [program.netQty, value?.netQty], [program.netAmt, value?.netAmt],
      [program.buyQty, value?.buyQty], [program.buyAmt, value?.buyAmt],
      [program.sellQty, value?.sellQty], [program.sellAmt, value?.sellAmt],
    ];
    for (const [node, number] of cells) {
      setText(node, value ? format(number) : DASH);
      setData(node, { value: number });
    }
  }

  function drawBrokers(section) {
    for (const side of ["sell", "buy"]) {
      brokers[side].forEach(({ row, name, qty }, index) => {
        const entry = section.value?.[side][index];
        const present = entry && entry.code !== 0;
        setText(name, present ? entry.name : DASH);
        setText(qty, present ? format(entry.qty) : DASH);
        setData(row, { name: present ? entry.name : null, qty: present ? entry.qty : null });
      });
    }
  }

  return {
    invalidate() {
      drawn.book = drawn.trades = drawn.program = drawn.broker = drawn.gap = null;
    },
    draw(frame) {
      if (frame.book.key !== drawn.book) { drawBook(frame.book); drawn.book = frame.book.key; }
      if (frame.trades.key !== drawn.trades) { drawTrades(frame.trades); drawn.trades = frame.trades.key; }
      if (frame.program.key !== drawn.program) { drawProgram(frame.program); drawn.program = frame.program.key; }
      if (frame.broker.key !== drawn.broker) { drawBrokers(frame.broker); drawn.broker = frame.broker.key; }
      if (frame.inGap !== drawn.gap) { book.gap.dataset.on = String(frame.inGap); drawn.gap = frame.inGap; }
    },
  };
}
