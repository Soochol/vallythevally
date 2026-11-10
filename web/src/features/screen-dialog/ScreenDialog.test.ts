import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ScreenFields } from "./ScreenDialog";
import { addCondition, draftOf } from "./screenForm";

const twoLines = addCondition({ ...draftOf(null), name: "고가와 거래량" });
const NAME = 1;
const PERIODS = 3;
const PER_LINE = 4;
const ADD_LINE = 1;
const CHIPS = 11;

function controlsOf(locked: boolean) {
  const markup = renderToStaticMarkup(createElement(ScreenFields, { ids: "t", draft: twoLines, nameError: null, locked, onChange: () => {} }));
  const enclosing: boolean[] = [];
  const controls: { tag: string; disabled: boolean }[] = [];
  for (const [tag] of markup.matchAll(/<\/?(fieldset|input|select|button)\b[^>]*>/g)) {
    if (tag === "</fieldset>") enclosing.pop();
    if (tag.startsWith("</")) continue;
    const own = tag.includes(' disabled=""');
    if (tag.startsWith("<fieldset")) enclosing.push(own);
    else controls.push({ tag, disabled: own || enclosing.includes(true) });
  }
  return controls;
}

test("저장 중에는 이름·봉 주기·조건 줄의 값·N·M·줄 더하기·빼기·제외 칩을 하나도 고치거나 누를 수 없다", () => {
  const controls = controlsOf(true);
  expect(controls).toHaveLength(NAME + PERIODS + 2 * PER_LINE + ADD_LINE + CHIPS);
  expect(controls.filter((c) => !c.disabled).map((c) => c.tag)).toEqual([]);
});

test("저장 중이 아니면 같은 칸을 모두 쓸 수 있다", () => {
  const controls = controlsOf(false);
  expect(controls).toHaveLength(NAME + PERIODS + 2 * PER_LINE + ADD_LINE + CHIPS);
  expect(controls.filter((c) => c.disabled).map((c) => c.tag)).toEqual([]);
});
