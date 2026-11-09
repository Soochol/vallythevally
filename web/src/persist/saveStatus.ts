import type { SaveTarget } from "../stores/persist";
import type { SaveState } from "./saver";

/** 상태 줄의 자동 저장 표시 하나(frontend.md §3.7). 세 자료의 상태를 하나로 합친다. */
export type SaveIndicator =
  | { kind: "hidden" }
  | { kind: "busy" }
  | { kind: "saved"; at: number }
  | { kind: "failed" }
  | { kind: "tooLarge"; hint: string | null };

/** 너무 클 때 사용자가 줄일 것(frontend.md §3.7a). UiState는 화면이 스스로 줄이고, 관심종목은 64KB에 닿지 않는다. */
const TOO_LARGE_HINT: Record<SaveTarget, string | null> = {
  layout: "지표나 비교 종목을 줄이세요",
  ui: null,
  watchlist: null,
};

const TARGETS = ["layout", "ui", "watchlist"] as const satisfies readonly SaveTarget[];

/** 앞의 것이 이긴다: 너무 큼 > 실패 > 저장 중 > 저장됨(가장 늦은 시각) > 숨김. */
export function saveIndicator(saves: Record<SaveTarget, SaveState>): SaveIndicator {
  const tooLarge = TARGETS.find((t) => {
    const s = saves[t];
    return s.kind === "failed" && s.reason === "too_large";
  });
  if (tooLarge) return { kind: "tooLarge", hint: TOO_LARGE_HINT[tooLarge] };
  const states = TARGETS.map((t) => saves[t]);
  if (states.some((s) => s.kind === "failed")) return { kind: "failed" };
  if (states.some((s) => s.kind === "pending" || s.kind === "saving")) return { kind: "busy" };
  const at = Math.max(...states.map((s) => (s.kind === "saved" ? s.at : -Infinity)));
  return at === -Infinity ? { kind: "hidden" } : { kind: "saved", at };
}
