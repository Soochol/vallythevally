import { describe, expect, it } from "vitest";
import { DEFAULT_ORDER_SETTINGS, MAX_PRESET_SHARES, parseOrderSettings, withPreset, withPresetOf } from "./orderSettings";

describe("호가주문 설정", () => {
  it("없거나 깨진 값은 기본값이다", () => {
    expect(parseOrderSettings(undefined)).toBe(DEFAULT_ORDER_SETTINGS);
    expect(parseOrderSettings({ sharePresets: [1, 2, 3] }).sharePresets).toEqual(DEFAULT_ORDER_SETTINGS.sharePresets);
    expect(parseOrderSettings({ rate: "yes" }).rate).toBe(true);
  });

  it("저장된 값을 읽는다", () => {
    expect(parseOrderSettings({ sharePresets: [1, 2, 3, 4], amountPresets: [5, 6, 7, 8], averageDot: false, divider: false, rate: false })).toEqual({ sharePresets: [1, 2, 3, 4], amountPresets: [5, 6, 7, 8], averageDot: false, divider: false, rate: false });
  });

  it("프리셋은 양의 정수만 받는다", () => {
    expect(withPreset(DEFAULT_ORDER_SETTINGS, 1, "75").sharePresets).toEqual([10, 75, 100, 500]);
    expect(withPreset(DEFAULT_ORDER_SETTINGS, 1, "0")).toBe(DEFAULT_ORDER_SETTINGS);
    expect(withPreset(DEFAULT_ORDER_SETTINGS, 1, "")).toBe(DEFAULT_ORDER_SETTINGS);
  });

  it("금액 프리셋이 없거나 깨지면 기본값이고 올바르면 그대로 읽는다", () => {
    expect(DEFAULT_ORDER_SETTINGS.amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({}).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [1, 2, 3] }).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [1, 0, 3, 4] }).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [1, 2.5, 3, 4] }).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [20, 30, 40, 50] }).amountPresets).toEqual([20, 30, 40, 50]);
  });

  it.each(["sharePresets", "amountPresets"] as const)("%s는 0, 빈 값, 소수, 상한 초과를 받지 않는다", (kind) => {
    for (const text of ["0", "", " ", "1.5", String(MAX_PRESET_SHARES + 1), "-3", "abc"]) expect(withPresetOf(DEFAULT_ORDER_SETTINGS, kind, 0, text)).toBe(DEFAULT_ORDER_SETTINGS);
    expect(withPresetOf(DEFAULT_ORDER_SETTINGS, kind, 0, String(MAX_PRESET_SHARES))[kind][0]).toBe(MAX_PRESET_SHARES);
  });
});
