import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

/** next가 prev의 마지막 봉만 바꾸거나 하나를 덧붙인 것인가(주 시리즈를 `update`로 그릴 수 있는가). */
export function isTailChange(prev: readonly Bar[], next: readonly Bar[], bar: Bar): boolean {
  if (next[next.length - 1] !== bar) return false;
  const kept = next.length - 1;
  if (kept !== prev.length && !(kept === prev.length - 1 && prev[kept]?.t === bar.t)) return false;
  return kept === 0 || next[kept - 1] === prev[kept - 1];
}

export type SyncOp = "preview" | "confirm" | "create";

/**
 * 실시간 봉 하나를 지표 엔진에 어떻게 넘길지(frontend.md §5.4). 엔진은 커밋한 마지막 확정 봉보다 늦은 봉만 받는다.
 * 같은 t로 확정 봉을 바꿔치기하거나 앞이 바뀐 경우는 처음부터 다시 만든다.
 */
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
