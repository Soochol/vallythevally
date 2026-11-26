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

const TV_HUES = ["빨강", "주황", "노랑", "초록", "청록", "하늘", "파랑", "남색", "보라", "분홍"] as const;

export const TV_GRAY_SWATCHES: readonly ColorSwatch[] = tableRow("무채색", GRAYS, [
  "#FFFFFF", "#E0E3EB", "#B2B5BE", "#9598A1", "#787B86", "#5D606B", "#434651", "#2A2E39", "#181B22", "#000000",
]).swatches;

export const TV_COLOR_MATRIX: readonly ColorTableRow[] = [
  tableRow("원색", TV_HUES, ["#F23645", "#FF9800", "#FFEB3B", "#4CAF50", "#089981", "#00BCD4", "#2962FF", "#673AB7", "#9C27B0", "#E91E63"]),
  tableRow("아주 밝게", TV_HUES.map((hue) => `아주 밝은 ${hue}`), ["#FCCBCD", "#FFE0B2", "#FFF9C4", "#C8E6C9", "#ACE5DC", "#B2EBF2", "#BBD9FB", "#D1C4E9", "#E1BEE7", "#F8BBD0"]),
  tableRow("밝게", TV_HUES.map((hue) => `밝은 ${hue}`), ["#FAA1A4", "#FFCC80", "#FFF59D", "#A5D6A7", "#70CCBD", "#80DEEA", "#90BFF9", "#B39DDB", "#CE93D8", "#F48FB1"]),
  tableRow("중간", TV_HUES.map((hue) => `중간 ${hue}`), ["#F77C80", "#FFB74D", "#FFF176", "#81C784", "#42BDA8", "#4DD0E1", "#5B9CF6", "#9575CD", "#BA68C8", "#F06292"]),
  tableRow("진하게", TV_HUES.map((hue) => `진한 ${hue}`), ["#CC2F3C", "#F57C00", "#FBC02D", "#388E3C", "#06806B", "#0097A7", "#1848CC", "#512DA8", "#7B1FA2", "#C2185B"]),
  tableRow("아주 진하게", TV_HUES.map((hue) => `아주 진한 ${hue}`), ["#801922", "#E65100", "#F57F17", "#1B5E20", "#056656", "#006064", "#0C3299", "#311B92", "#4A148C", "#880E4F"]),
];

export const FALLBACK_PICKED_COLOR = "#C7F36B" as HexColor;

export const sameColor = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

export function colorName(color: HexColor): string {
  const all = [...COLOR_TABLE, ...TV_COLOR_MATRIX].flatMap((row) => row.swatches).concat(TV_GRAY_SWATCHES);
  return all.find((swatch) => sameColor(swatch.color, color))?.name ?? color.toUpperCase();
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
