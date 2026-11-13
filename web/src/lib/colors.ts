export type HexColor = string & { readonly __brand: "HexColor" };

export const isHexColor = (value: unknown): value is HexColor => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export function normalizeHex(value: string): HexColor | null {
  const raw = value.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(raw) ? [...raw].map((c) => c + c).join("") : raw;
  const color = `#${full.toUpperCase()}`;
  return isHexColor(color) ? color : null;
}

const HUES = ["빨강", "주황", "노랑", "라임", "초록", "청록", "하늘", "파랑", "보라", "분홍"] as const;
const GRAYS = ["흰색", "회색 1", "회색 2", "회색 3", "회색 4", "회색 5", "회색 6", "회색 7", "회색 8", "회색 9"] as const;

export interface ColorSwatch { name: string; color: HexColor }
export interface ColorTableRow { label: string; swatches: readonly ColorSwatch[] }

function tableRow(label: string, names: readonly string[], values: readonly string[]): ColorTableRow {
  const swatches = values.map((value, i) => {
    const color = normalizeHex(value);
    if (!color) throw new Error("색상표 값이 올바르지 않습니다");
    return { name: names[i] ?? color, color };
  });
  return { label, swatches };
}

export const COLOR_TABLE: readonly ColorTableRow[] = [
  tableRow("밝게", HUES.map((hue) => `밝은 ${hue}`), ["#FFA3AB", "#FFC7A1", "#F6E3A0", "#DEF9A6", "#B0E8C2", "#A6E7DA", "#A5E1EC", "#A9C9FF", "#D4C8FF", "#F6C3E3"]),
  tableRow("기본", HUES, ["#FF6B78", "#F4935F", "#EBD06F", "#C7F36B", "#7FD69A", "#5FCDB8", "#6EC7D8", "#73A8FF", "#A48CFA", "#EE9DD0"]),
  tableRow("진하게", HUES.map((hue) => `진한 ${hue}`), ["#D9485A", "#D97A45", "#C29A45", "#94C23C", "#4CA977", "#42A99D", "#459DBD", "#4A7FE0", "#8B74E0", "#CC6BA8"]),
  tableRow("무채색", GRAYS, ["#FFFFFF", "#F0F4EC", "#D7DED1", "#C6CEC0", "#AEB8A8", "#98A391", "#87947F", "#78836F", "#5F695A", "#465044"]),
];

export const PRESET_COLORS: readonly HexColor[] = COLOR_TABLE.flatMap((row) => row.swatches.map((swatch) => swatch.color));

export const sameColor = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

export function colorName(color: HexColor): string {
  return COLOR_TABLE.flatMap((row) => row.swatches).find((swatch) => sameColor(swatch.color, color))?.name ?? color.toUpperCase();
}

export interface HsvColor { h: number; s: number; v: number }

export function hexToHsv(hex: HexColor): HsvColor {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: HsvColor): HexColor {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const text = `#${rgb.map((n) => Math.round((n + m) * 255).toString(16).padStart(2, "0")).join("")}`;
  const color = normalizeHex(text);
  if (!color) throw new Error("색상 범위가 올바르지 않습니다");
  return color;
}
