import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PriceLadder } from "./PriceLadder";
import { buildLadder } from "./ladder";

const rows = buildLadder({
  asks: [{ price: 71600, quantity: 300, change: 40 }, { price: 71700, quantity: 900, change: 0 }],
  bids: [{ price: 71500, quantity: 450, change: -20 }],
  lastPrice: 71500,
  previousClose: 70000,
});

test("행은 스무 개이고 현재가 행에만 강조와 전일 대비 등락률이 붙는다", () => {
  const html = renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 70000 }));
  expect(html.match(/class="mw-lr"/g)).toHaveLength(20);
  expect(html.match(/data-current/g)).toHaveLength(1);
  expect(html).toContain("<small>+2.14%</small>");
  expect(html).toContain("71,500");
});

test("잔량 막대는 가장 큰 잔량 900을 100%로 잡는다", () => {
  const html = renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 70000 }));
  expect(html).toContain("width:100%");
  expect(html).toContain("width:50%");
});

test("왼쪽·오른쪽 칸은 slot이 있을 때만 열이 생기고 행마다 그 slot이 그려진다", () => {
  const plain = renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 70000 }));
  const slotted = renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 70000, slots: { left: (row) => createElement("em", { className: "left" }, row.key), right: (row) => createElement("em", { className: "right" }, row.key) } }));
  expect(plain).toContain("grid-template-columns:1fr var(--size-84) 1fr");
  expect(slotted).toContain("grid-template-columns:auto 1fr var(--size-84) 1fr auto");
  expect(slotted.match(/class="left"/g)).toHaveLength(20);
  expect(slotted.match(/class="right"/g)).toHaveLength(20);
});

test("잔량이 늘면 상승, 줄면 하락 증감 뱃지를 부호와 함께 보인다", () => {
  const html = renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 70000 }));
  expect(html).toContain('data-flash="up">+40주');
  expect(html).toContain('data-flash="down">−20주');
});

test("기준가가 0이면 가격은 상승색이 아니다", () => {
  const html = renderToStaticMarkup(createElement(PriceLadder, { rows, previousClose: 0 }));
  expect(html).not.toContain("mw-up");
  expect(html).not.toContain("mw-down");
});
