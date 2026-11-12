import { expect, test } from "vitest";
import { hexToHsv, hsvToHex, normalizeHex, PRESET_COLORS } from "./colors";

test("48색은 서로 다르고 모두 저장 가능한 색이며 색조·채도·밝기를 거쳐도 그대로다", () => {
  expect(PRESET_COLORS).toHaveLength(48);
  expect(new Set(PRESET_COLORS).size).toBe(48);
  for (const color of [...PRESET_COLORS, "#000000", "#FFFFFF"]) {
    const parsed = normalizeHex(color);
    expect(parsed).not.toBeNull();
    if (parsed) expect(hsvToHex(hexToHsv(parsed))).toBe(parsed);
  }
});

test("직접 입력한 색은 정규화하고 CSS 식이나 깨진 색은 받지 않는다", () => {
  expect(normalizeHex(" 8b5cf6 ")).toBe("#8B5CF6");
  expect(normalizeHex("#abc")).toBe("#AABBCC");
  for (const color of ["red", "#12", "#FFFFFF00", "var(--accent)", "url(x)", "#GGGGGG"]) expect(normalizeHex(color)).toBeNull();
});
