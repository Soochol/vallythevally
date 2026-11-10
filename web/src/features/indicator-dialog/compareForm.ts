import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { type ChartSettings, type CompareRefusal, compareRefusal, MAX_COMPARE, type PriceScale } from "../../chart/settings";

export const AXIS_LOCKED = "비교 종목이 있으면 % 축으로 그립니다";
export const LOG_LOCKED = `${AXIS_LOCKED}. 로그 축은 비교 종목을 지운 뒤 씁니다`;

const REFUSAL_TEXT: Record<CompareRefusal, string> = {
  full: `비교 종목은 ${MAX_COMPARE}개까지입니다`,
  dup: "이미 넣은 비교 종목입니다",
  main: "이 칸의 종목입니다",
};

export function pressScale(s: Pick<ChartSettings, "scale" | "compare">, button: "log" | "percent"): PriceScale | null {
  if (s.compare.length > 0) return null;
  return s.scale === button ? "normal" : button;
}

export interface AddButton {
  label: string;
  ok: boolean;
  reason: string | null;
}

export function addButton(s: Pick<ChartSettings, "compare">, picked: SymbolInfo | null, main: SymbolCode): AddButton {
  if (!picked) return { label: "비교 종목 추가", ok: false, reason: s.compare.length >= MAX_COMPARE ? REFUSAL_TEXT.full : null };
  const refusal = compareRefusal(s, picked.code, main);
  return { label: `${picked.name} 추가`, ok: refusal === null, reason: refusal && REFUSAL_TEXT[refusal] };
}

export function stepIndex(index: number, by: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return by === 1 ? 0 : length - 1;
  return (index + by + length) % length;
}
