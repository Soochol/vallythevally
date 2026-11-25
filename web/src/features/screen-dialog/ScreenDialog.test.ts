import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import { ScreenFields } from "./ScreenDialog";
import { CHOICE_LABEL } from "./ConditionFields";
import { isBarKind } from "../../lib/screener";
import { conditionChoices } from "../screener/SentenceFields";
import { addCondition, changeKind, draftOf, editCondition, removeCondition, KIND_GROUPS, type ScreenDraft } from "./screenForm";

const twoLines = addCondition(addCondition({ ...draftOf(null), name: "고가와 거래량" }));
const NAME = 1;
const PER_NEW_HIGH_LINE = 7;
const ADD_LINE = 1;
const MARKETS = 2;
const CHIPS = 14;

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
const tokenOf = (markup: string, label: string) => markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>([^<]*)</button>`))?.[1];

test("저장 중에는 이름·조건 줄의 종류·봉 주기·값·N·M·끌기·메뉴·조건 추가·시장과 제외 칩을 하나도 고치거나 누를 수 없다", () => {
  const controls = controlsOf(true);
  expect(controls).toHaveLength(NAME + 2 * PER_NEW_HIGH_LINE + ADD_LINE + MARKETS + CHIPS);
  expect(controls.filter((c) => !c.disabled).map((c) => c.tag)).toEqual([]);
});

test("저장 중이 아니면 모든 칸과 버튼을 쓸 수 있고 옮기기·복제·지우기는 줄 메뉴에 있다", () => {
  const controls = controlsOf(false);
  expect(controls).toHaveLength(NAME + 2 * PER_NEW_HIGH_LINE + ADD_LINE + MARKETS + CHIPS);
  expect(controls.filter((c) => c.disabled).map((c) => c.tag)).toEqual([]);
  expect(labelsIn(markupOf(twoLines)).filter((l) => l.endsWith(" 메뉴"))).toEqual(["조건 1 메뉴", "조건 2 메뉴"]);
});

test("새 조건식은 조건 줄 없이 '조건 없음 · 대상 종목 전체'로 열리고, 한 줄만 남아도 그 줄의 메뉴가 있다", () => {
  const empty = markupOf(draftOf(null));
  expect(empty).toContain("조건 없음 · 대상 종목 전체");
  expect(empty).toContain("0/10줄");
  expect(labelsIn(empty).filter((l) => l.startsWith("조건 "))).toEqual([]);
  expect(empty.match(/<button[^>]*>(?:(?!<button).)*조건 추가/)?.[0]).not.toContain('disabled=""');

  const one = addCondition(draftOf(null));
  const markup = markupOf(one);
  expect(markup).not.toContain("조건 없음 · 대상 종목 전체");
  expect(markup).toMatch(/<button(?![^>]*disabled="")[^>]*aria-label="조건 1 메뉴"[^>]*>/);
  expect(markupOf(removeCondition(one, one.conditions[0]!.key))).toContain("조건 없음 · 대상 종목 전체");
});

test("조건 줄은 끌기, 종류, 봉 주기, 최근 기간, 그 종류의 칸, 메뉴 순이고, 시가총액 줄에는 봉 주기와 최근 기간이 없다", () => {
  const screen: Screen = {
    id: "s",
    name: "섞임",
    markets: [],
    exclude: [],
    conditions: [
      { kind: "new_high", period: "W", recentBars: 2, field: "high", n: 52 },
      { kind: "market_cap", min: 300_000_000_000, max: null },
    ],
  };
  const labels = labelsIn(markupOf(draftOf(screen)));
  expect(labels.filter((l) => l.startsWith("조건 1 "))).toEqual(["조건 1 순서 끌어서 바꾸기", "조건 1 종류", "조건 1 봉 주기", "조건 1 최근 기간", "조건 1 값", "조건 1 신고가 기간", "조건 1 메뉴"]);
  expect(labels.filter((l) => l.startsWith("조건 2 "))).toEqual(["조건 2 순서 끌어서 바꾸기", "조건 2 종류", "조건 2 최소", "조건 2 비교", "조건 2 메뉴"]);
});

test("문장의 숫자 토큰은 값과 단위를 붙여 읽히고, 거래대금과 시가총액 칸은 억 원이다", () => {
  const screen: Screen = {
    id: "s",
    name: "섞임",
    markets: ["kospi"],
    exclude: [],
    conditions: [
      { kind: "value_range", period: "W", recentBars: 1, field: "traded_value", min: 10_000_000_000, max: null },
      { kind: "market_cap", min: 300_000_000_000, max: null },
      { kind: "ma_cross", period: "M", recentBars: 3, method: "sma", fast: 5, slow: 20, direction: "up" },
    ],
  };
  const markup = markupOf(draftOf(screen));
  expect(tokenOf(markup, "조건 1 최소")).toBe("100");
  expect(markup).toMatch(/aria-label="조건 1 최소"[^>]*>100<\/button>억 원<\/span>/);
  expect(tokenOf(markup, "조건 2 최소")).toBe("3000");
  expect(markup).toMatch(/aria-label="조건 2 종류"[^>]*>시가총액<svg/);
  expect(markup).toMatch(/aria-label="조건 3 짧은 이평"[^>]*>5<\/button>개월선이<\/span>/);
  expect(markup).toMatch(/aria-label="조건 3 긴 이평"[^>]*>20<\/button>개월선을<\/span>/);
  expect(markup).toContain("<span>교차한</span>");
  expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>코스피<\/button>/);
  expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>코스닥<\/button>/);
});

test("거래량 값 범위 줄은 숫자 칸 뒤에 단위 글자도 빈 단위 칸도 그리지 않는다", () => {
  const screen: Screen = {
    id: "s",
    name: "거래량",
    markets: ["kospi"],
    exclude: [],
    conditions: [
      { kind: "value_range", period: "D", recentBars: 1, field: "volume", min: 100_000, max: 5_000_000 },
      { kind: "value_range", period: "D", recentBars: 1, field: "traded_value", min: 10_000_000_000, max: 20_000_000_000 },
    ],
  };
  const markup = markupOf(draftOf(screen));
  expect(markup).toMatch(/aria-label="조건 1 최소"[^>]*>100000<\/button><\/span>/);
  expect(markup).toMatch(/aria-label="조건 1 최대"[^>]*>5000000<\/button><\/span><span>이하인<\/span>/);
  expect(markup).not.toContain("<span></span>");
  expect(markup).toContain("억 원");
});

test("잘못된 칸은 그 칸에 표시되고 줄 아래에 칸 이름과 이유가 붙는다", () => {
  const draft = draftOf({ id: "s", name: "s", markets: [], exclude: [], conditions: [{ kind: "macd", period: "D", recentBars: 1, fast: 12, slow: 26, signal: 9, test: { kind: "signal_cross", direction: "up" } }] });
  const line = draft.conditions[0]!;
  if (line.kind !== "macd") throw new Error("MACD 줄이어야 한다");
  const markup = markupOf(editCondition(draft, { ...line, fast: "30" }));
  const fast = markup.match(/<button[^>]*aria-label="조건 1 빠른 기간"[^>]*>/)?.[0] ?? "";
  expect(tokenOf(markup, "조건 1 빠른 기간")).toBe("30");
  expect(fast).toContain('aria-invalid="true"');
  expect(fast).toContain('aria-describedby="t-condition-0-fast-error"');
  expect(markup.match(/<button[^>]*aria-label="조건 1 느린 기간"[^>]*>/)?.[0]).toContain('aria-invalid="false"');
  expect(markup).toContain('id="t-condition-0-fast-error"');
  expect(markup).toContain("빠른 기간: 느린 기간 26일보다 짧아야 합니다");
});

test("종류 검색은 묶음별로 모든 조건을 보이고, 문장 맨 앞 종류 낱말이 지금 종류다", () => {
  const markup = markupOf(addCondition(draftOf(null)));
  const groups = KIND_GROUPS.map((group) => [group.label, conditionChoices("").filter((choice) => choice.group === group.label).map((choice) => choice.label)]);
  expect(conditionChoices("")).toHaveLength(20);
  expect(groups).toEqual([
    ["가격", ["신고가", "신저가", "값 범위", "등락률", "고점·저점 거리"]],
    ["거래", ["신고거래량", "신고거래대금", "거래 급증"]],
    ["이동평균", ["이평 위치", "이평 배열", "이평 교차"]],
    ["보조지표", ["RSI", "MACD", "스토캐스틱", "볼린저 밴드", "일목균형표"]],
    ["수급·미시", ["프로그램 순매수", "고래 순매수", "VI 발동 이력"]],
    ["종목", ["시가총액"]],
  ]);
  expect(markup).toMatch(new RegExp(`aria-label="조건 1 종류"[^>]*>${CHOICE_LABEL.new_high}<svg`));
  expect(markup).toMatch(/aria-label="조건 1 값"[^>]*data-value="high"/);
});

test("거래대금 신고가 줄은 종류 낱말이 신고거래대금이고 값 칸 없이 거래대금이 최고인 문장으로 읽힌다", () => {
  const traded = draftOf({ id: "s", name: "신고거래대금", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", recentBars: 1, field: "traded_value", n: 60 }] });
  const markup = markupOf(traded);
  expect(markup).toMatch(/aria-label="조건 1 종류"[^>]*>신고거래대금<svg/);
  expect(labelsIn(markup).filter((l) => l.startsWith("조건 1 "))).toEqual(["조건 1 순서 끌어서 바꾸기", "조건 1 종류", "조건 1 봉 주기", "조건 1 최근 기간", "조건 1 신고거래대금 기간", "조건 1 메뉴"]);
  expect(tokenOf(markup, "조건 1 신고거래대금 기간")).toBe("60");
  expect(markup).toMatch(/<span>거래대금이<\/span>[^]*?>60<\/button>일<\/span><span>최고인<\/span>/);
});

test("모든 봉 조건과 거래 신고 항목은 최근 기간을 세부 값 앞에 두고 D/W/M 단위를 붙이며 도움말은 맨 아래 한 번이다", () => {
  for (const { kinds } of KIND_GROUPS) {
    for (const kind of kinds) {
      const picked = changeKind(addCondition(draftOf(null)), 0, kind);
      for (const period of ["D", "W", "M"] as const) {
        const line = picked.conditions[0]!;
        const markup = markupOf(editCondition(picked, { ...line, period, recentBars: "260" }));
        const labels = labelsIn(markup).filter((label) => label.startsWith("조건 1 "));
        if (!isBarKind(line.kind)) {
          expect(labels).not.toContain("조건 1 최근 기간");
          expect(labels).not.toContain("조건 1 봉 주기");
        } else {
          expect(labels.slice(1, 4)).toEqual(["조건 1 종류", "조건 1 봉 주기", "조건 1 최근 기간"]);
          expect(tokenOf(markup, "조건 1 최근 기간")).toBe("260");
          expect(markup).toMatch(new RegExp(`>260</button>${period === "D" ? "일" : period === "W" ? "주" : "개월"}</span><span>이내에</span>`));
        }
        expect([...markup.matchAll(/마지막 봉을 포함한 실제 봉 개수입니다/g)]).toHaveLength(1);
      }
    }
  }
});
