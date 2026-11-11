export type HexColor = string & { readonly __brand: "HexColor" };

export const isHexColor = (value: unknown): value is HexColor => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export function normalizeHex(value: string): HexColor | null {
  const raw = value.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(raw) ? [...raw].map((c) => c + c).join("") : raw;
  const color = `#${full.toUpperCase()}`;
  return isHexColor(color) ? color : null;
}

const PRESET_VALUES = [
  "#FF747E", "#F49C73", "#D4B575", "#E7D77D", "#C7F36B", "#80C995", "#69C7B7", "#6EC7D8",
  "#73A8FF", "#8C9DFA", "#B5A2F5", "#D6A2F2", "#EE9DD0", "#E9A6AE", "#B4C3A1", "#A8B693",
  "#F0F3EB", "#C6CEC0", "#A4B09C", "#87947F", "#D3B9A0", "#BDA0A7", "#A5B6CA", "#7DB9AB",
  "#FF9FA6", "#FFC7A1", "#F8DCA0", "#F6EFA8", "#DAF9A0", "#A6E7BB", "#9AE9DD", "#A5E6F2",
  "#A5C9FF", "#B7BEFF", "#D2BCFF", "#E9BDFF", "#FFBCE6", "#F6CFD5", "#D3DFC0", "#D1D9C5",
  "#DE5863", "#DC7C46", "#BE9C4B", "#BAAD3F", "#91BF3D", "#4CA977", "#42A99D", "#459DBD",
];

export const PRESET_COLORS: readonly HexColor[] = PRESET_VALUES.filter(isHexColor);

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
