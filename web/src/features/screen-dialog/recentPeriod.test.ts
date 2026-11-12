import { expect, test } from "vitest";
import { addCondition, checkCondition, draftOf, changeKind } from "./screenForm";

test("최근 기간 하나를 저장하고 종류를 바꾸어도 유지한다", () => {
  const draft = addCondition(draftOf(null));
  const line = draft.conditions[0]!;
  expect(checkCondition(line)).toMatchObject({ ok: true, condition: { recentBars: 1 } });
  const changed = changeKind({ ...draft, conditions: [Object.assign({}, line, { recentBars: "260" })] }, line.key, "rsi");
  expect(checkCondition(changed.conditions[0]!)).toMatchObject({ ok: true, condition: { recentBars: 260 } });
});
