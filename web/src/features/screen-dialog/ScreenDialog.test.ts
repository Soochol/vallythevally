import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import { ScreenFields } from "./ScreenDialog";
import { addCondition, draftOf, editCondition, type ScreenDraft } from "./screenForm";

const twoLines = addCondition({ ...draftOf(null), name: "고가와 거래량" });
const NAME = 1;
const PER_NEW_HIGH_LINE = 8;
const ADD_LINE = 1;
const MARKETS = 2;
const CHIPS = 11;

const markupOf = (draft: ScreenDraft, locked = false) => renderToStaticMarkup(createElement(ScreenFields, { ids: "t", draft, nameError: null, locked, onChange: () => {} }));

function controlsOf(locked: boolean) {
  const enclosing: boolean[] = [];
  const controls: { tag: string; disabled: boolean }[] = [];
  for (const [tag] of markupOf(twoLines, locked).matchAll(/<\/?(fieldset|input|select|button)\b[^>]*>/g)) {
    if (tag === "</fieldset>") enclosing.pop();
    if (tag.startsWith("</")) continue;
    const own = tag.includes(' disabled=""');
    if (tag.startsWith("<fieldset")) enclosing.push(own);
    else controls.push({ tag, disabled: own || enclosing.includes(true) });
  }
  return controls;
}

const labelsIn = (markup: string) => [...markup.matchAll(/aria-label="([^"]+)"/g)].map(([, label]) => label ?? "");
const inputOf = (markup: string, label: string) => markup.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

test("저장 중에는 이름·조건 줄의 종류·봉 주기·값·N·M·옮기기·빼기·줄 더하기·시장과 제외 칩을 하나도 고치거나 누를 수 없다", () => {
  const controls = controlsOf(true);
  expect(controls).toHaveLength(NAME + 2 * PER_NEW_HIGH_LINE + ADD_LINE + MARKETS + CHIPS);
  expect(controls.filter((c) => !c.disabled).map((c) => c.tag)).toEqual([]);
});

test("저장 중이 아니면 첫 줄 ▲와 끝 줄 ▼만 빼고 모두 쓸 수 있다", () => {
  const controls = controlsOf(false);
  expect(controls).toHaveLength(NAME + 2 * PER_NEW_HIGH_LINE + ADD_LINE + MARKETS + CHIPS);
  expect(controls.filter((c) => c.disabled).map((c) => c.tag.match(/aria-label="([^"]+)"/)?.[1])).toEqual(["조건 1 위로 옮기기", "조건 2 아래로 옮기기"]);
});

test("조건 줄은 종류, 봉 주기, 그 종류의 칸, ▲▼, 빼기 순이고, 시가총액 줄에는 봉 주기와 M이 없다", () => {
  const screen: Screen = {
    id: "s",
    name: "섞임",
    markets: [],
    exclude: [],
    conditions: [
      { kind: "new_high", period: "W", m: 2, field: "high", n: 52 },
      { kind: "market_cap", min: 300_000_000_000, max: null },
    ],
  };
  const labels = labelsIn(markupOf(draftOf(screen)));
  expect(labels.filter((l) => l.startsWith("조건 1 "))).toEqual(["조건 1 종류", "조건 1 봉 주기", "조건 1 값", "조건 1 신고가 기간", "조건 1 최근 봉 수", "조건 1 위로 옮기기", "조건 1 아래로 옮기기", "조건 1 빼기"]);
  expect(labels.filter((l) => l.startsWith("조건 2 "))).toEqual(["조건 2 종류", "조건 2 최소", "조건 2 최대", "조건 2 위로 옮기기", "조건 2 아래로 옮기기", "조건 2 빼기"]);
});

test("줄 아래에는 그 줄의 봉 주기로 쓴 문장이 붙고, 거래대금과 시가총액 칸은 억 원이다", () => {
  const screen: Screen = {
    id: "s",
    name: "섞임",
    markets: ["kospi"],
    exclude: [],
    conditions: [
      { kind: "value_range", period: "W", m: 1, field: "traded_value", min: 10_000_000_000, max: null },
      { kind: "market_cap", min: 300_000_000_000, max: null },
      { kind: "ma_cross", period: "M", m: 3, method: "sma", fast: 5, slow: 20, direction: "up" },
    ],
  };
  const markup = markupOf(draftOf(screen));
  expect(markup).toContain("이번 주 거래대금이 100억 원 이상이다");
  expect(markup).toContain("시가총액이 3,000억 원 이상이다");
  expect(markup).toContain("최근 3개월 안에 5개월선이 20개월선을 위로 교차한 봉이 있다");
  expect(inputOf(markup, "조건 1 최소")).toContain('value="100"');
  expect(inputOf(markup, "조건 2 최소")).toContain('value="3000"');
  expect(markup).toContain("<span>억 원 이상</span>");
  expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>코스피<\/button>/);
  expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>코스닥<\/button>/);
});

test("잘못된 칸은 그 칸에 표시되고 줄 아래에 칸 이름과 이유가 붙으며, 그 줄의 문장은 보이지 않는다", () => {
  const draft = draftOf({ id: "s", name: "s", markets: [], exclude: [], conditions: [{ kind: "macd", period: "D", m: 1, fast: 12, slow: 26, signal: 9, test: { kind: "signal_cross", direction: "up" } }] });
  const line = draft.conditions[0]!;
  if (line.kind !== "macd") throw new Error("MACD 줄이어야 한다");
  const markup = markupOf(editCondition(draft, { ...line, fast: "30" }));
  const fast = inputOf(markup, "조건 1 빠른 기간");
  expect(fast).toContain('value="30"');
  expect(fast).toContain('aria-invalid="true"');
  expect(fast).toContain('aria-describedby="t-condition-0-fast-error"');
  expect(inputOf(markup, "조건 1 느린 기간")).toContain('aria-invalid="false"');
  expect(markup).toContain('id="t-condition-0-fast-error"');
  expect(markup).toContain("빠른 기간: 느린 기간 26일보다 짧아야 합니다");
  expect(markup).not.toContain("MACD(30·26·9)");
});

test("종류 메뉴는 묶음별로 15가지를 보이고, 지금 종류가 골라져 있다", () => {
  const markup = markupOf(draftOf(null));
  const groups = [...markup.matchAll(/<optgroup label="([^"]+)">(.*?)<\/optgroup>/g)].map(([, label, options]) => [label, [...options!.matchAll(/>([^<]+)<\/option>/g)].map(([, text]) => text)]);
  expect(groups).toEqual([
    ["가격", ["신고가", "신저가", "값 범위", "등락률", "고점·저점 거리"]],
    ["거래", ["거래 급증"]],
    ["이동평균", ["이평 위치", "이평 배열", "이평 교차"]],
    ["보조지표", ["RSI", "MACD", "스토캐스틱", "볼린저 밴드", "일목균형표"]],
    ["종목", ["시가총액"]],
  ]);
  expect(markup).toContain('<option value="new_high" selected="">신고가</option>');
});

test("거래대금 신고가 줄은 값 칸에 거래대금을 고른 채로 보이고 신고거래대금으로 읽힌다", () => {
  const traded = draftOf({ id: "s", name: "신고거래대금", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", m: 1, field: "traded_value", n: 60 }] });
  const markup = markupOf(traded);
  expect(markup).toContain('<option value="traded_value" selected="">거래대금</option>');
  expect(markup).toContain("일 신고거래대금");
  expect(markup).toContain("당일 거래대금이 60일 신고거래대금이다");
});
