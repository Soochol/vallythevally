import { describe, expect, it } from "vitest";
import { CHART_SETTINGS_SECTIONS } from "./menus";

describe("차트 설정 구역", () => {
  it("봉 · 선, 축 · 눈금, 시간 순서로 쌓는다", () => {
    expect(CHART_SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      "봉 · 선",
      "축 · 눈금",
      "시간",
    ]);
  });
});
