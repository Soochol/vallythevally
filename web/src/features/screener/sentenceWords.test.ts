import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { addCondition, changeKind, draftOf, type ConditionDraft, type KindChoice } from "../screen-dialog/screenForm";
import { SentenceCondition } from "./SentenceFields";

const CASES: readonly { kind: KindChoice; word: string; field: string }[] = [
  { kind: "new_high", word: "신고가", field: "고가" },
  { kind: "new_low", word: "신저가", field: "저가" },
  { kind: "volume_high", word: "신고거래량", field: "거래량" },
  { kind: "traded_value_high", word: "신고거래대금", field: "거래대금" },
];

function lineOf(kind: KindChoice): ConditionDraft {
  const draft = addCondition(draftOf(null));
  const key = draft.conditions.at(-1)!.key;
  return changeKind(draft, key, kind).conditions.find((line) => line.key === key)!;
}

const sentenceOf = (kind: KindChoice): string =>
  renderToStaticMarkup(createElement(SentenceCondition, { ids: "t", line: lineOf(kind), index: 0, onChange: () => {}, onKind: () => {} })).replace(/<[^>]+>/g, " ");

const count = (text: string, word: string): number => text.split(word).length - 1;

test("종류 낱말은 조건 문장에 한 번만 나오고 값 낱말은 남는다", () => {
  for (const { kind, word, field } of CASES) {
    const text = sentenceOf(kind);
    expect({ kind, kindWord: count(text, word) }).toEqual({ kind, kindWord: 1 });
    expect({ kind, fieldWord: count(text, field) - count(text, word) >= 1 }).toEqual({ kind, fieldWord: true });
  }
});
