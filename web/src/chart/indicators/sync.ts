import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

export function isTailChange(prev: readonly Bar[], next: readonly Bar[], bar: Bar): boolean {
  if (next[next.length - 1] !== bar) return false;
  const kept = next.length - 1;
  if (kept !== prev.length && !(kept === prev.length - 1 && prev[kept]?.t === bar.t)) return false;
  return kept === 0 || next[kept - 1] === prev[kept - 1];
}

export type SyncOp = "preview" | "confirm" | "create";

export function syncOp(
  prev: readonly Bar[],
  next: readonly Bar[],
  bar: Bar,
  kind: "live" | "confirmed",
  committedT: UnixSeconds | null,
): SyncOp {
  if (!isTailChange(prev, next, bar) || (committedT !== null && bar.t <= committedT)) return "create";
  return kind === "confirmed" ? "confirm" : "preview";
}
