import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";

export function previewRow(rows: readonly ScreenerRow[], chosen: SymbolCode | null, active: SymbolCode): ScreenerRow | null {
  return rows.find((row) => row.symbol === chosen) ?? rows.find((row) => row.symbol === active) ?? rows[0] ?? null;
}

export function nextResult(rows: readonly ScreenerRow[], from: SymbolCode | null, step: -1 | 1): SymbolCode | null {
  const at = rows.findIndex((row) => row.symbol === from);
  const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
  return next === at ? null : rows[next]?.symbol ?? null;
}

type ResultKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented">;
export type ResultAction = { kind: "run" } | { kind: "move"; step: -1 | 1 } | { kind: "open" };

export function resultKeyAction(event: ResultKey, wide: boolean): ResultAction | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return null;
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) return { kind: "run" };
  if (event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowDown") return { kind: "move", step: 1 };
  if (event.key === "ArrowUp") return { kind: "move", step: -1 };
  return event.key === "Enter" && wide ? { kind: "open" } : null;
}
