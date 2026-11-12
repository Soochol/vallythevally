import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import { addCondition, changeKind, checkCondition, draftOf, editCondition, editNumber, KIND_GROUPS, type ScreenDraft } from "../screen-dialog/screenForm";
import { conditionChoices, SentenceCondition, SentenceFields } from "./SentenceFields";

const markupOf = (draft: ScreenDraft, locked = false) => renderToStaticMarkup(createElement(SentenceFields, { draft, locked, onChange: () => {} }));

test("모든 조건 종류를 문장의 밑줄 값과 메뉴로 편집하고 숫자 입력 상자는 팝오버에만 둔다", () => {
  for (const kind of KIND_GROUPS.flatMap((group) => group.kinds)) {
    const draft = changeKind(addCondition(draftOf(null)), 0, kind);
    const line = draft.conditions[0]!;
    expect(checkCondition(line).ok, kind).toBe(true);
    const markup = markupOf(draft);
    expect(markup, kind).toContain('aria-label="조건 1 메뉴"');
    expect(markup, kind).toContain('aria-haspopup="dialog"');
    expect(markup, kind).not.toContain("<input");
    expect(markup, kind).toContain('aria-label="조건 1 순서 끌어서 바꾸기"');
    expect(markup.includes('aria-label="조건 1 봉 주기"'), kind).toBe(kind !== "market_cap");
  }
});

test("주·월봉, 봉 범위, 억 원과 비교 메뉴를 문장에 유지한다", () => {
  const screen: Screen = { id: "s", name: "s", markets: ["kospi"], exclude: ["etf", "trading_halted"], conditions: [
    { kind: "new_high", period: "W", barRange: { start: 2, end: 8 }, field: "volume", n: 52 },
    { kind: "market_cap", min: 300_000_000_000, max: null },
  ] };
  const markup = markupOf(draftOf(screen));
  expect(markup).toContain('data-value="W"');
  expect(markup).toContain("봉 전 안에");
  expect(markup).toContain("52");
  expect(markup).toContain("신고거래량");
  expect(markup).toContain("3000");
  expect(markup).toContain("억 원");
  expect(markup).toContain('aria-label="조건 2 비교"');
  expect(markup).toContain("이상");
  expect(markup).toContain('aria-label="ETF 제외 해제"');
  expect(markup).toContain('aria-label="거래정지 제외 해제"');
  expect(markup).toContain('aria-pressed="true"');
});

test("잘못된 숫자는 값 버튼과 연결된 오류를 보이고 행의 다른 값도 계속 편집한다", () => {
  const draft = addCondition(draftOf(null));
  const line = { ...draft.conditions[0]!, n: "0", rangeStart: "3", rangeEnd: "1" };
  const markup = renderToStaticMarkup(createElement(SentenceCondition, { ids: "t", line, index: 0, onChange: () => {} }));
  expect(markup).toContain('aria-invalid="true"');
  expect(markup).toContain('aria-describedby="t-condition-0-n-error"');
  expect(markup).toContain('id="t-condition-0-n-error"');
  expect(markup).toContain("신고가 기간: 1 이상의 정수를 넣으세요");
  expect(markup).toContain("봉 범위 끝: 시작보다 작을 수 없습니다");
  expect(markup).toContain('aria-label="조건 1 값"');
});

test("종류 검색은 그룹·이름·약어로 찾고 검색 결과가 없을 수 있다", () => {
  expect(conditionChoices("")).toHaveLength(17);
  expect(conditionChoices(" rSi ").map((choice) => choice.kind)).toEqual(["rsi"]);
  expect(conditionChoices("이동평균").map((choice) => choice.kind)).toEqual(["ma_position", "ma_alignment", "ma_cross"]);
  expect(conditionChoices("거래").map((choice) => choice.kind)).toEqual(["volume_high", "traded_value_high", "surge"]);
  expect(conditionChoices("없는 조건")).toEqual([]);
});

test("숫자와 봉 단위를 함께 적용해도 봉 범위와 다른 세부 값은 유지한다", () => {
  const line = addCondition(draftOf(null)).conditions[0]!;
  const changed = editNumber(line, "n", "52", "W");
  expect(changed).toEqual({ ...line, n: "52", period: "W" });
  expect(checkCondition(changed)).toEqual({ ok: true, condition: { kind: "new_high", n: 52, field: "high", period: "W", barRange: { start: 0, end: 0 } } });
  const alignment = changeKind(addCondition(draftOf(null)), 0, "ma_alignment").conditions[0]!;
  expect(editNumber(alignment, "lengths.1", "30", "M")).toEqual({ ...alignment, period: "M", lengths: ["5", "30", "60", "120"] });
});

test("조건이 없어도 실행 가능한 대상 전체 안내와 추가가 보이고 저장 중에는 모두 잠근다", () => {
  expect(markupOf(draftOf(null))).toContain("조건 없음 · 대상 종목 전체");
  expect(markupOf(draftOf(null), true)).toContain('disabled=""');
  let draft = draftOf(null);
  for (let n = 0; n < 10; n++) draft = addCondition(draft);
  const markup = markupOf(draft);
  const addButton = markup.match(/<button[^>]*>[^]*?조건 추가<\/button>/g)?.at(-1);
  expect(addButton).toContain('disabled=""');
});

test("RSI·스토캐스틱·볼린저·일목의 세부 판정과 이동평균 선 개수도 문장에 남긴다", () => {
  const defaults = addCondition(draftOf(null));
  for (const kind of ["rsi", "stochastic", "bollinger", "ichimoku", "ma_alignment"] as const) {
    const draft = changeKind(defaults, 0, kind);
    const line = draft.conditions[0]!;
    const alternate = line.kind === "rsi" ? { ...line, test: "breakout" as const }
      : line.kind === "stochastic" ? { ...line, test: "range" as const }
      : line.kind === "bollinger" ? { ...line, test: "cross" as const }
      : line.kind === "ichimoku" ? { ...line, test: "cross" as const } : line;
    const markup = markupOf(editCondition(draft, alternate));
    expect(markup).toContain(kind === "ma_alignment" ? "이평 더하기" : 'aria-label="조건 1 판정"');
    if (kind === "rsi") expect(markup).toContain('aria-label="조건 1 돌파 값"');
    if (kind === "bollinger") expect(markup).toContain('aria-label="조건 1 밴드"');
  }
});
