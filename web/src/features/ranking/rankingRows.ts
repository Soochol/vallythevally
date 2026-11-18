import type { RankingRow } from "../../api/generated/RankingRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";

export function nextCode(rows: readonly RankingRow[], from: SymbolCode | null, step: -1 | 1): SymbolCode | null {
  const at = rows.findIndex((row) => row.code === from);
  const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
  return next === at ? null : rows[next]?.code ?? null;
}
