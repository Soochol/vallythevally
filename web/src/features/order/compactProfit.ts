import { MINUS } from "../../lib/format";

const intFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

const MAN = 10_000;
const EOK = 100_000_000;

export function compactProfitText(won: number): string {
  const sign = won > 0 ? "+" : won < 0 ? MINUS : "";
  const abs = Math.trunc(Math.abs(won));
  if (abs < MAN) return `${sign}${intFormat.format(abs)}원`;
  if (abs < EOK) {
    const tenths = Math.floor(abs / 1_000);
    return `${sign}${intFormat.format(Math.floor(tenths / 10))}.${tenths % 10}만`;
  }
  const hundredths = Math.floor(abs / 1_000_000);
  const fraction = String(hundredths % 100).padStart(2, "0");
  return `${sign}${intFormat.format(Math.floor(hundredths / 100))}.${fraction}억`;
}
