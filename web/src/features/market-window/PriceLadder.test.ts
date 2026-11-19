import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PriceLadder, tradeBoxStart, type LadderRowSlots } from "./PriceLadder";
import { buildLadder } from "./ladder";

const rows = buildLadder({
  asks: [{ price: 71600, quantity: 300, change: 40 }, { price: 71700, quantity: 900, change: 0 }],
  bids: [{ price: 71500, quantity: 450, change: -20 }],
  lastPrice: 71500,
  previousClose: 70000,
  bounds: { lower: null, upper: null },
  tickRule: "stock",
});
const render = (props: Partial<Parameters<typeof PriceLadder>[0]> = {}) => renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 70000, ...props }));

test("행은 스무 개이고 현재가 행에만 강조가 붙으며 등락률은 값이 있는 모든 행에 있다", () => {
  const html = render();
  expect(html.match(/class="mw-lr"/g)).toHaveLength(20);
  expect(html.match(/data-current/g)).toHaveLength(1);
  expect(html).toContain("<small>+2.14%</small>");
  expect(html.match(/<small>/g)).toHaveLength(20);
});

test("잔량 막대는 가장 큰 잔량 900을 100%로 잡는다", () => {
  const html = render();
  expect(html).toContain("width:100%");
  expect(html).toContain("width:50%");
});

test("모든 행의 열 정의가 같고 왼쪽·오른쪽 칸은 slot이 있을 때만 고정 폭 열이 생긴다", () => {
  const slotted = render({ slots: { left: (row) => createElement("em", { className: "left" }, row.key), right: (row) => createElement("em", { className: "right" }, row.key) } });
  expect(render().match(/grid-template-columns:([^"]*)"/g)?.every((style) => style === 'grid-template-columns:minmax(0, 1fr) var(--size-133) minmax(0, 1fr)"')).toBe(true);
  expect(new Set(slotted.match(/grid-template-columns:[^"]*/g))).toEqual(new Set(["grid-template-columns:var(--size-64) minmax(0, 1fr) var(--size-133) minmax(0, 1fr) var(--size-64)"]));
  expect(slotted.match(/class="left"/g)).toHaveLength(20);
  expect(slotted.match(/class="right"/g)).toHaveLength(20);
});

test("잔량이 늘면 상승, 줄면 하락 증감 글자를 부호와 함께 잔량 칸 안에 보인다", () => {
  const html = render();
  expect(html).toContain('class="mw-qty-change" data-flash="up">+40');
  expect(html).toContain('class="mw-qty-change" data-flash="down">−20');
  expect(html).not.toContain("mw-qty-delta");
  expect(html).not.toContain("주");
  expect(html).toMatch(/mw-qty-change" data-flash="up">\+40<\/span><span class="mw-qty-value">300/);
  expect(html).toMatch(/mw-qty-value">450<\/span><span class="mw-qty-change" data-flash="down">/);
});

test("기준가가 0이면 가격은 상승색이 아니다", () => {
  const html = render({ previousClose: 0 });
  expect(html).not.toContain("mw-up");
  expect(html).not.toContain("mw-down");
});

test("위 오른쪽 자리는 1~9행의 빈 매수 잔량 칸에만 그리고, 아래 왼쪽 자리는 11~20행을 덮는 상자 하나로 그린다", () => {
  const rowSlots: LadderRowSlots = {
    topRight: (slot) => createElement("em", { className: "top" }, `t${slot}`),
    bottomLeft: (rowCount) => createElement("em", { className: "bottom" }, `b${rowCount}`),
  };
  const html = render({ rowSlots });
  expect(tradeBoxStart(rows)).toBe(10);
  expect(html).toContain("top:calc(var(--s1) + 10 * var(--size-24));height:calc(10 * var(--size-24))");
  expect(html.match(/<em class="top">t\d<\/em>/g)).toEqual(["<em class=\"top\">t0</em>", "<em class=\"top\">t1</em>", "<em class=\"top\">t2</em>", "<em class=\"top\">t3</em>", "<em class=\"top\">t4</em>", "<em class=\"top\">t5</em>", "<em class=\"top\">t6</em>", "<em class=\"top\">t7</em>", "<em class=\"top\">t8</em>"]);
  expect(html.match(/<em class="bottom">b\d+<\/em>/g)).toEqual(['<em class="bottom">b10</em>']);
  expect(html.indexOf('class="bottom"')).toBeGreaterThan(html.indexOf("mw-box-layer"));
});

test("11~20행 가운데 매도 잔량이 있는 행은 상자가 가리지 않고 그 아래 행부터 상자를 줄인다", () => {
  const crossed = buildLadder({
    asks: [{ price: 71000, quantity: 5, change: 0 }, { price: 70100, quantity: 7, change: 0 }, { price: 69500, quantity: 2, change: 0 }],
    bids: [{ price: 70900, quantity: 9, change: 0 }, { price: 69100, quantity: 3, change: 0 }],
    lastPrice: 70000,
    previousClose: 70000,
    bounds: { lower: null, upper: null },
  tickRule: "stock",
  });
  const html = renderToStaticMarkup(createElement(PriceLadder, {
    rows: crossed,
    previousClose: 70000,
    rowSlots: { topRight: (slot) => createElement("em", { className: "top" }, `t${slot}`), bottomLeft: (rowCount) => createElement("em", { className: "bottom" }, `b${rowCount}`) },
  }));
  expect(html.match(/class="top"/g)).toHaveLength(8);
  expect(html).not.toContain("<em class=\"top\">t1</em>");
  expect(html.match(/class="bottom"/g)).toHaveLength(1);
  expect(html).toContain('<em class="bottom">b4</em>');
  expect(tradeBoxStart(crossed)).toBe(16);
  expect(html).toContain("top:calc(var(--s1) + 16 * var(--size-24));height:calc(4 * var(--size-24))");
});

test("표시 가격 하나에만 가격 숫자 앞에 점이 붙는다", () => {
  const html = render({ mark: { price: 71700, label: "평단가" } });
  expect(html.match(/ladder-mark/g)).toHaveLength(1);
  expect(html).toContain('<span class="mw-px-num"><i class="mw-px-mark" data-testid="ladder-mark" title="평단가"></i>71,700</span>');
  expect(render({ mark: { price: 12345, label: "평단가" } })).not.toContain("ladder-mark");
});

test("예상체결가와 같은 가격의 행 하나에만 data-expected가 붙고 행 수는 그대로다", () => {
  const html = render({ expectedPrice: 71_700 });
  expect(html.match(/data-expected/g)).toHaveLength(1);
  expect(html.match(/class="mw-lr"/g)).toHaveLength(20);
  expect(html).toMatch(/data-expected=""[^>]*>.*?71,700/);
  expect(render().match(/data-expected/g)).toBeNull();
  expect(render({ expectedPrice: 12_345 }).match(/data-expected/g)).toBeNull();
});
