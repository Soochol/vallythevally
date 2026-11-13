import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";

export function nextResult(rows: readonly ScreenerRow[], from: SymbolCode | null, step: -1 | 1): SymbolCode | null {
  const at = rows.findIndex((row) => row.symbol === from);
  const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
  return next === at ? null : rows[next]?.symbol ?? null;
}

type ResultKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented">;
export type ResultAction = { kind: "run" } | { kind: "move"; step: -1 | 1 };

export function resultKeyAction(event: ResultKey): ResultAction | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return null;
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) return { kind: "run" };
  if (event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowDown") return { kind: "move", step: 1 };
  return event.key === "ArrowUp" ? { kind: "move", step: -1 } : null;
}
