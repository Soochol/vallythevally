import { expect, test } from "vitest";
import { COLOR_TABLE, colorName, hexToHsv, hsvToHex, normalizeHex, PRESET_COLORS } from "./colors";

test("색상표는 10색 4줄이고 색은 서로 다르며 색조·채도·밝기를 거쳐도 그대로다", () => {
  expect(COLOR_TABLE.map((row) => row.label)).toEqual(["밝게", "기본", "진하게", "무채색"]);
  for (const row of COLOR_TABLE) expect(row.swatches).toHaveLength(10);
  expect(COLOR_TABLE[1]!.swatches.map((swatch) => swatch.name)).toEqual(["빨강", "주황", "노랑", "라임", "초록", "청록", "하늘", "파랑", "보라", "분홍"]);
  expect(new Set(PRESET_COLORS).size).toBe(40);
  expect(new Set(COLOR_TABLE.flatMap((row) => row.swatches.map((swatch) => swatch.name))).size).toBe(40);
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

test("색 이름은 대소문자와 상관없이 표에서 찾고 표에 없는 색은 HEX로 부른다", () => {
  expect(colorName(normalizeHex("#d9485a")!)).toBe("진한 빨강");
  expect(colorName(normalizeHex("#123456")!)).toBe("#123456");
});
