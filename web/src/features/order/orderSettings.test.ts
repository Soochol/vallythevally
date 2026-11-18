import { describe, expect, it } from "vitest";
import { DEFAULT_ORDER_SETTINGS, parseOrderSettings, withPreset } from "./orderSettings";

describe("호가주문 설정", () => {
  it("없거나 깨진 값은 기본값이다", () => {
    expect(parseOrderSettings(undefined)).toBe(DEFAULT_ORDER_SETTINGS);
    expect(parseOrderSettings({ sharePresets: [1, 2, 3] }).sharePresets).toEqual(DEFAULT_ORDER_SETTINGS.sharePresets);
    expect(parseOrderSettings({ rate: "yes" }).rate).toBe(true);
  });

  it("저장된 값을 읽는다", () => {
    expect(parseOrderSettings({ sharePresets: [1, 2, 3, 4], averageDot: false, divider: false, rate: false })).toEqual({ sharePresets: [1, 2, 3, 4], averageDot: false, divider: false, rate: false });
  });

  it("프리셋은 양의 정수만 받는다", () => {
    expect(withPreset(DEFAULT_ORDER_SETTINGS, 1, "75").sharePresets).toEqual([10, 75, 100, 500]);
    expect(withPreset(DEFAULT_ORDER_SETTINGS, 1, "0")).toBe(DEFAULT_ORDER_SETTINGS);
    expect(withPreset(DEFAULT_ORDER_SETTINGS, 1, "")).toBe(DEFAULT_ORDER_SETTINGS);
  });
});
