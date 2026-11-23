import { describe, expect, it } from "vitest";
import type { MenuItem } from "../menu/Menu";
import { mergeRepeatedReasons } from "./menuReasons";

const blocked = (label: string, disabledReason: string): MenuItem => ({ kind: "action", label, disabled: true, disabledReason, onSelect: () => undefined });
const reasonsOf = (items: readonly MenuItem[]) => items.map((item) => (item.kind === "action" ? item.disabledReason : null));

describe("비활성 사유 합치기", () => {
  it("같은 사유가 이어지면 첫 줄에만 남긴다", () => {
    const merged = mergeRepeatedReasons([blocked("왼쪽", "작음"), blocked("오른쪽", "작음"), blocked("위", "작음")]);
    expect(reasonsOf(merged)).toEqual(["작음", undefined, undefined]);
  });

  it("사유가 바뀌거나 구분선이 끼면 다시 보여 준다", () => {
    const merged = mergeRepeatedReasons([blocked("왼쪽", "작음"), blocked("오른쪽", "다름"), { kind: "separator" }, blocked("위", "다름")]);
    expect(reasonsOf(merged)).toEqual(["작음", "다름", null, "다름"]);
  });
});
