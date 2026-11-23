export interface Rgba { r: number; g: number; b: number; a: number }

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const FUNCTION_COLOR = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

export function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = HEX_COLOR.exec(text);
  if (hex) return { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16), a: 1 };
  const fn = FUNCTION_COLOR.exec(text);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  throw new Error(`색 값을 읽을 수 없다: ${value}`);
}

export function over(top: Rgba, base: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 };
}

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ r, g, b }: Rgba): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function lab({ r, g, b }: Rgba): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const degrees = (rad: number): number => ((rad * 180) / Math.PI + 360) % 360;
const POW7_25 = 25 ** 7;

export function deltaE2000(first: Rgba, second: Rgba): number {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + POW7_25)));
  const [a1p, a2p] = [(1 + g) * a1, (1 + g) * a2];
  const [c1, c2] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const [h1, h2] = [c1 === 0 ? 0 : degrees(Math.atan2(b1, a1p)), c2 === 0 ? 0 : degrees(Math.atan2(b2, a2p))];
  const dL = l2 - l1;
  const dC = c2 - c1;
  let dh = 0;
  if (c1 * c2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(dh / 2));
  const meanL = (l1 + l2) / 2;
  const meanC = (c1 + c2) / 2;
  let meanH = h1 + h2;
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) meanH /= 2;
    else meanH = (meanH + (h1 + h2 < 360 ? 360 : -360)) / 2;
  }
  const t = 1 - 0.17 * Math.cos(radians(meanH - 30)) + 0.24 * Math.cos(radians(2 * meanH)) + 0.32 * Math.cos(radians(3 * meanH + 6)) - 0.2 * Math.cos(radians(4 * meanH - 63));
  const rotation = -Math.sin(radians(60 * Math.exp(-(((meanH - 275) / 25) ** 2)))) * 2 * Math.sqrt(meanC ** 7 / (meanC ** 7 + POW7_25));
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanC;
  const sh = 1 + 0.015 * meanC * t;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rotation * (dC / sc) * (dH / sh));
}

export function parseCustomProperties(css: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    if (!properties.has(match[1]!)) properties.set(match[1]!, match[2]!.trim());
  }
  return properties;
}
