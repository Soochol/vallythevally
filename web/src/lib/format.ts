// 숫자 표기(frontend.md §1.3). 음수 부호는 U+2212(−)다.
export const MINUS = "−";

const int = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type Direction = "up" | "down" | "flat";

export function direction(x: number): Direction {
  return x > 0 ? "up" : x < 0 ? "down" : "flat";
}

function abs(x: number, isIndex: boolean): string {
  return isIndex ? two.format(Math.abs(x)) : int.format(Math.abs(Math.round(x)));
}

function sign(x: number): string {
  return x > 0 ? "+" : x < 0 ? MINUS : "";
}

/** 주식은 원 단위 정수(`85,400`), 지수는 소수 둘째 자리(`1,963.30`). */
export function formatPrice(p: number, isIndex: boolean): string {
  return (p < 0 ? MINUS : "") + abs(p, isIndex);
}

/** 변화량. 부호를 항상 붙인다(`+1,600`, `−500`). */
export function formatChange(chg: number, isIndex: boolean): string {
  const rounded = isIndex ? Math.round(chg * 100) / 100 : Math.round(chg);
  return sign(rounded) + abs(rounded, isIndex);
}

/** 등락률. `+1.86%`, `−0.58%`. */
export function formatPercent(pct: number): string {
  const rounded = Math.round(pct * 100) / 100;
  return sign(rounded) + two.format(Math.abs(rounded)) + "%";
}

/** 거래량. `33만`, `25.64억`. 만 아래는 그대로. */
export function formatVolume(v: number): string {
  if (v >= 1e8) return two.format(v / 1e8) + "억";
  if (v >= 1e4) return int.format(Math.round(v / 1e4)) + "만";
  return int.format(v);
}
