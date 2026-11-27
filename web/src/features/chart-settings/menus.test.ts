import { describe, expect, it } from "vitest";
import { CHART_SETTINGS_SECTIONS, SCOPE_LABEL, scopeTitle } from "./menus";

describe("차트 설정 구역", () => {
  it("봉 · 축, 범례 · 표시, 격자 · 구분선, 창 · 동작 순서로 쌓고 창 · 동작만 모든 차트에 적용한다", () => {
    expect(CHART_SETTINGS_SECTIONS.map((section) => [section.label, SCOPE_LABEL[section.scope]])).toEqual([
      ["봉 · 축", "이 칸"],
      ["범례 · 표시", "이 칸"],
      ["격자 · 구분선", "이 칸"],
      ["창 · 동작", "모든 차트"],
    ]);
  });
  it("적용 범위 알약의 풍선말은 칸 이름이나 모든 차트를 가리킨다", () => {
    expect(scopeTitle("cell", "삼성전자 · 일")).toBe("삼성전자 · 일에 적용");
    expect(scopeTitle("all", "삼성전자 · 일")).toBe("모든 차트에 적용");
  });
});
